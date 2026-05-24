require("dotenv").config();
const express = require("express");
const { Client } = require("@notionhq/client");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Validate env vars early
if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
  console.error("❌  Missing NOTION_TOKEN or NOTION_DATABASE_ID in .env");
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ─── Notion helpers ─────────────────────────────────────────────────────────

/** Pull all pages from the database (handles pagination automatically) */
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

/** Safely read a property value from a Notion page */
function getProp(page, name) {
  return page.properties?.[name];
}

function getText(page, name) {
  const prop = getProp(page, name);
  if (!prop) return "";
  if (prop.type === "title")
    return prop.title?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "status") return prop.status?.name || "";
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

  const briefingDate = getDate(page, "Briefing Date");
  const interviewDate = getDate(page, "Interview Date");
  const published = getCheckbox(page, "Published Mini-Talk to YouTube");

  // Stage 6: Published
  if (published) return "Published";

  // Stage 5: Interview Done — interview happened but not published yet
  if (interviewDate && interviewDate < now) return "Interview Done";

  // Stage 4: Interview Booked — interview date in future
  if (interviewDate && interviewDate >= now) return "Interview Booked";

  // Stage 3: Briefing Done — briefing happened, no interview scheduled
  if (briefingDate && briefingDate < now) return "Briefing Done";

  // Stage 2: Briefing Booked — briefing date in future
  if (briefingDate && briefingDate >= now) return "Briefing Booked";

  // Stage 1: Outreach Sent — everything else
  return "Outreach Sent";
}

/** Returns the days since a date (negative = in the future) */
function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

// ─── Main data transform ─────────────────────────────────────────────────────

function buildDashboard(pages) {
  const now = new Date();

  // Week boundaries (Mon–Sun)
  const dayOfWeek = now.getDay(); // 0=Sun
  const daysFromMon = (dayOfWeek + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysFromMon);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const stageGuests = Object.fromEntries(STAGES.map((s) => [s, []]));
  const overdue = [];
  let weeklyInterviews = 0;
  let weeklyBriefings = 0;
  let totalActive = 0;

  for (const page of pages) {
    const name = getText(page, "Guest Name") || "Unnamed";
    const stage = classifyGuest(page);
    const briefingDate = getDate(page, "Briefing Date");
    const interviewDate = getDate(page, "Interview Date");
    const invitationDate = getDate(page, "Invitation Date");

    stageCounts[stage]++;
    stageGuests[stage].push({
      id: page.id,
      name,
      stage,
      briefingDate: briefingDate?.toISOString() || null,
      interviewDate: interviewDate?.toISOString() || null,
      invitationDate: invitationDate?.toISOString() || null,
      published: getCheckbox(page, "Published Mini-Talk to YouTube"),
      offerMade: getCheckbox(page, "Offer Made"),
      assetsCreated: getCheckbox(page, "Assets Created"),
      assetsShared: getCheckbox(page, "Assets Shared"),
      reels1: getCheckbox(page, "Reels & Stories #1 Published"),
      reels2: getCheckbox(page, "Reels & Stories #2 Published"),
      reels3: getCheckbox(page, "Reels & Stories #3 Published"),
    });

    if (stage !== "Published") totalActive++;

    // Weekly interview count
    if (
      interviewDate &&
      interviewDate >= weekStart &&
      interviewDate < weekEnd &&
      interviewDate < now
    ) {
      weeklyInterviews++;
    }

    // Weekly briefing count
    if (
      briefingDate &&
      briefingDate >= weekStart &&
      briefingDate < weekEnd &&
      briefingDate < now
    ) {
      weeklyBriefings++;
    }

    // Overdue checks — briefing done but no interview booked after 7 days
    if (stage === "Briefing Done" && briefingDate) {
      const age = daysSince(briefingDate);
      if (age >= 7) {
        overdue.push({
          name,
          stage,
          reason: `Briefing done ${age}d ago — no interview scheduled`,
          daysOverdue: age - 7,
          id: page.id,
        });
      }
    }

    // Overdue: interview done but not published after 14 days
    if (stage === "Interview Done" && interviewDate) {
      const age = daysSince(interviewDate);
      if (age >= 14) {
        overdue.push({
          name,
          stage,
          reason: `Interview done ${age}d ago — not yet published`,
          daysOverdue: age - 14,
          id: page.id,
        });
      }
    }

    // Overdue: outreach sent but no briefing booked after 14 days
    if (stage === "Outreach Sent" && invitationDate) {
      const age = daysSince(invitationDate);
      if (age >= 14) {
        overdue.push({
          name,
          stage,
          reason: `Outreach sent ${age}d ago — no briefing booked`,
          daysOverdue: age - 14,
          id: page.id,
        });
      }
    }
  }

  // Sort overdue by most days overdue first
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  // Pipeline health score (0–100)
  const publishedCount = stageCounts["Published"];
  const totalGuests = pages.length;
  const conversionRate =
    totalGuests > 0 ? Math.round((publishedCount / totalGuests) * 100) : 0;
  const overdueScore = Math.max(
    0,
    100 - overdue.length * 10 - stageCounts["Outreach Sent"] * 2
  );
  const healthScore = Math.round(
    (conversionRate * 0.4 + overdueScore * 0.6)
  );

  return {
    lastUpdated: new Date().toISOString(),
    totalGuests,
    totalActive,
    weeklyInterviews,
    weeklyBriefings,
    healthScore: Math.min(100, Math.max(0, healthScore)),
    stages: STAGES.map((name) => ({
      name,
      count: stageCounts[name],
      guests: stageGuests[name],
    })),
    overdue,
  };
}

// ─── API routes ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/dashboard", async (req, res) => {
  try {
    const pages = await fetchAllGuests();
    const data = buildDashboard(pages);
    res.json(data);
  } catch (err) {
    console.error("Notion API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check for Vercel / uptime monitors
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎙️  Mini-Talks Dashboard running at http://localhost:${PORT}\n`);
});
