require("dotenv").config();
const express = require("express");
const { Client } = require("@notionhq/client");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Validate env vars early
if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
  console.error("❌  Missing NOTION_TOKEN or NOTION_DATABASE_ID in .env");
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ─── Notion helpers ─────────────────────────────────────────────────────────

async function fetchAllGuests() {
  const results = [];
  let cursor = undefined;
  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

function getProp(page, name) {
  return page.properties?.[name];
}

function getText(page, name) {
  const prop = getProp(page, name);
  if (!prop) return "";
  if (prop.type === "title")    return prop.title?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "rich_text") return prop.rich_text?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "select")   return prop.select?.name || "";
  if (prop.type === "status")   return prop.status?.name || "";
  return "";
}

function getDate(page, name) {
  const prop = getProp(page, name);
  if (!prop || prop.type !== "date") return null;
  return prop.date?.start ? new Date(prop.date.start) : null;
}

function getCheckbox(page, name) {
  const prop = getProp(page, name);
  if (!prop || prop.type !== "checkbox") return false;
  return prop.checkbox === true;
}

/** Build a Notion properties object from a flat update payload */
function buildNotionProperties(updates) {
  const props = {};

  if (updates.name !== undefined)
    props["Name"] = { title: [{ text: { content: updates.name } }] };

  if (updates.source !== undefined)
    props["Source"] = { rich_text: [{ text: { content: updates.source } }] };

  if ("invitationDate" in updates)
    props["Invitation to briefing"] = updates.invitationDate
      ? { date: { start: updates.invitationDate } }
      : { date: null };

  if ("briefingDate" in updates)
    props["Briefing"] = updates.briefingDate
      ? { date: { start: updates.briefingDate } }
      : { date: null };

  if ("interviewDate" in updates)
    props["Interview"] = updates.interviewDate
      ? { date: { start: updates.interviewDate } }
      : { date: null };

  if (updates.offerMade !== undefined)
    props["Offer Made"] = { checkbox: updates.offerMade };

  if (updates.assetsCreated !== undefined)
    props["Assets Created"] = { checkbox: updates.assetsCreated };

  if (updates.assetsShared !== undefined)
    props["Assets Shared"] = { checkbox: updates.assetsShared };

  if (updates.published !== undefined)
    props["Published Mini-Talk to YouTube"] = { checkbox: updates.published };

  if (updates.reels1 !== undefined)
    props["Reels & Stories #1 Published"] = { checkbox: updates.reels1 };

  if (updates.reels2 !== undefined)
    props["Reels & Stories #2 Published"] = { checkbox: updates.reels2 };

  if (updates.reels3 !== undefined)
    props["Reels & Stories #3 Published"] = { checkbox: updates.reels3 };

  return props;
}

// ─── Pipeline stage classification ──────────────────────────────────────────

const STAGES = [
  "Outreach Sent",
  "Briefing Booked",
  "Briefing Done",
  "Interview Booked",
  "Interview Done",
  "Published",
];

function classifyGuest(page) {
  const now = new Date();
  const briefingDate  = getDate(page, "Briefing");
  const interviewDate = getDate(page, "Interview");
  const published     = getCheckbox(page, "Published Mini-Talk to YouTube");

  if (published)                                   return "Published";
  if (interviewDate && interviewDate < now)        return "Interview Done";
  if (interviewDate && interviewDate >= now)       return "Interview Booked";
  if (briefingDate  && briefingDate < now)         return "Briefing Done";
  if (briefingDate  && briefingDate >= now)        return "Briefing Booked";
  return "Outreach Sent";
}

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function pageToGuest(page) {
  const briefingDate  = getDate(page, "Briefing");
  const interviewDate = getDate(page, "Interview");
  const invitationDate = getDate(page, "Invitation to briefing");
  return {
    id:             page.id,
    name:           getText(page, "Name") || "Unnamed",
    source:         getText(page, "Source") || "",
    stage:          classifyGuest(page),
    briefingDate:   briefingDate?.toISOString().split("T")[0]  || null,
    interviewDate:  interviewDate?.toISOString().split("T")[0] || null,
    invitationDate: invitationDate?.toISOString().split("T")[0] || null,
    published:      getCheckbox(page, "Published Mini-Talk to YouTube"),
    offerMade:      getCheckbox(page, "Offer Made"),
    assetsCreated:  getCheckbox(page, "Assets Created"),
    assetsShared:   getCheckbox(page, "Assets Shared"),
    reels1:         getCheckbox(page, "Reels & Stories #1 Published"),
    reels2:         getCheckbox(page, "Reels & Stories #2 Published"),
    reels3:         getCheckbox(page, "Reels & Stories #3 Published"),
  };
}

// ─── Main data transform ─────────────────────────────────────────────────────

function buildDashboard(pages) {
  const now = new Date();
  const dayOfWeek  = now.getDay();
  const daysFromMon = (dayOfWeek + 6) % 7;
  const weekStart  = new Date(now);
  weekStart.setDate(now.getDate() - daysFromMon);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const stageGuests = Object.fromEntries(STAGES.map((s) => [s, []]));
  const overdue = [];
  let weeklyInterviews = 0;
  let weeklyBriefings  = 0;
  let totalActive = 0;

  for (const page of pages) {
    const guest = pageToGuest(page);
    stageCounts[guest.stage]++;
    stageGuests[guest.stage].push(guest);

    if (guest.stage !== "Published") totalActive++;

    const briefingDate  = guest.briefingDate  ? new Date(guest.briefingDate)  : null;
    const interviewDate = guest.interviewDate ? new Date(guest.interviewDate) : null;
    const invitationDate = guest.invitationDate ? new Date(guest.invitationDate) : null;

    if (interviewDate && interviewDate >= weekStart && interviewDate < weekEnd && interviewDate < now)
      weeklyInterviews++;
    if (briefingDate  && briefingDate  >= weekStart && briefingDate  < weekEnd && briefingDate  < now)
      weeklyBriefings++;

    if (guest.stage === "Briefing Done" && briefingDate) {
      const age = daysSince(briefingDate);
      if (age >= 7)
        overdue.push({ name: guest.name, stage: guest.stage, id: guest.id,
          reason: `Briefing done ${age}d ago — no interview scheduled`, daysOverdue: age - 7 });
    }
    if (guest.stage === "Interview Done" && interviewDate) {
      const age = daysSince(interviewDate);
      if (age >= 14)
        overdue.push({ name: guest.name, stage: guest.stage, id: guest.id,
          reason: `Interview done ${age}d ago — not yet published`, daysOverdue: age - 14 });
    }
    if (guest.stage === "Outreach Sent" && invitationDate) {
      const age = daysSince(invitationDate);
      if (age >= 14)
        overdue.push({ name: guest.name, stage: guest.stage, id: guest.id,
          reason: `Outreach sent ${age}d ago — no briefing booked`, daysOverdue: age - 14 });
    }
  }

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const publishedCount = stageCounts["Published"];
  const totalGuests    = pages.length;
  const conversionRate = totalGuests > 0 ? Math.round((publishedCount / totalGuests) * 100) : 0;
  const overdueScore   = Math.max(0, 100 - overdue.length * 10 - stageCounts["Outreach Sent"] * 2);
  const healthScore    = Math.min(100, Math.max(0, Math.round(conversionRate * 0.4 + overdueScore * 0.6)));

  return {
    lastUpdated: new Date().toISOString(),
    totalGuests, totalActive, weeklyInterviews, weeklyBriefings, healthScore,
    stages: STAGES.map((name) => ({ name, count: stageCounts[name], guests: stageGuests[name] })),
    overdue,
  };
}

// ─── API routes ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// Read dashboard
app.get("/api/dashboard", async (req, res) => {
  try {
    const pages = await fetchAllGuests();
    res.json(buildDashboard(pages));
  } catch (err) {
    console.error("Notion API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create new guest
app.post("/api/guests", async (req, res) => {
  try {
    const props = buildNotionProperties(req.body);
    if (!props["Name"]) return res.status(400).json({ error: "name is required" });
    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: props,
    });
    res.json(pageToGuest(page));
  } catch (err) {
    console.error("Create guest error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update existing guest
app.patch("/api/guests/:id", async (req, res) => {
  try {
    const props = buildNotionProperties(req.body);
    const page = await notion.pages.update({
      page_id: req.params.id,
      properties: props,
    });
    res.json(pageToGuest(page));
  } catch (err) {
    console.error("Update guest error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎙️  Mini-Talks Dashboard running at http://localhost:${PORT}\n`);
});
