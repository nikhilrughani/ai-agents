require("dotenv").config();
const express = require("express");
const { Client } = require("@notionhq/client");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ─── Credential extraction ────────────────────────────────────────────────────
// Credentials come from either:
//  a) Request headers  (distributed / hosted use — set by setup wizard via localStorage)
//  b) .env file        (local / self-hosted use — backward compatible)
function getCredentials(req) {
  return {
    source:      (req.headers["x-data-source"]  || process.env.DATA_SOURCE  || "notion").toLowerCase(),
    notionToken: req.headers["x-notion-token"]  || process.env.NOTION_TOKEN  || "",
    notionDbId:  req.headers["x-notion-db-id"]  || process.env.NOTION_DATABASE_ID || "",
    sheetsUrl:   req.headers["x-sheets-url"]    || process.env.SHEETS_URL    || "",
  };
}

// ─── Notion property helpers ──────────────────────────────────────────────────
function getProp(page, name)  { return page.properties?.[name]; }

function getText(page, name) {
  const p = getProp(page, name);
  if (!p) return "";
  if (p.type === "title")     return p.title?.map(t => t.plain_text).join("") || "";
  if (p.type === "rich_text") return p.rich_text?.map(t => t.plain_text).join("") || "";
  if (p.type === "select")    return p.select?.name || "";
  if (p.type === "status")    return p.status?.name || "";
  return "";
}

function getDate(page, name) {
  const p = getProp(page, name);
  if (!p || p.type !== "date") return null;
  return p.date?.start ? new Date(p.date.start) : null;
}

function getCheckbox(page, name) {
  const p = getProp(page, name);
  return p?.type === "checkbox" ? p.checkbox === true : false;
}

// ─── Normalised Guest object (source-agnostic) ────────────────────────────────
// Both adapters return Guest[]; buildDashboard works on this shape.
// { id, name, source, notes, invitationDate, briefingDate, interviewDate,
//   published, offerMade, assetsCreated, assetsShared, reels1, reels2, reels3 }

function notionPageToGuest(page) {
  const bd  = getDate(page, "Briefing");
  const id  = getDate(page, "Interview");
  const inv = getDate(page, "Invitation to briefing");
  return {
    id:             page.id,
    name:           getText(page, "Name") || "Unnamed",
    source:         getText(page, "Source") || "",
    notes:          getText(page, "Notes") || "",
    invitationDate: inv ? inv.toISOString().split("T")[0] : null,
    briefingDate:   bd  ? bd.toISOString().split("T")[0]  : null,
    interviewDate:  id  ? id.toISOString().split("T")[0]  : null,
    published:      getCheckbox(page, "Published Mini-Talk to YouTube"),
    offerMade:      getCheckbox(page, "Offer Made"),
    assetsCreated:  getCheckbox(page, "Assets Created"),
    assetsShared:   getCheckbox(page, "Assets Shared"),
    reels1:         getCheckbox(page, "Reels & Stories #1 Published"),
    reels2:         getCheckbox(page, "Reels & Stories #2 Published"),
    reels3:         getCheckbox(page, "Reels & Stories #3 Published"),
  };
}

// ─── Google Sheets adapter (read-only) ───────────────────────────────────────

function normalizeSheetsUrl(raw) {
  if (!raw) throw new Error("No Google Sheets URL provided");
  // Already a CSV export / publish URL
  if (raw.includes("output=csv") || raw.includes("format=csv")) return raw;
  // Standard edit URL → extract ID and build export URL
  const m = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
  // Bare spreadsheet ID
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw.trim()))
    return `https://docs.google.com/spreadsheets/d/${raw.trim()}/export?format=csv`;
  throw new Error("Couldn't recognise the Google Sheets URL. Please use the full URL or a publish-to-web CSV link.");
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if      (c === '"')                      inQ = true;
      else if (c === ',')                      { row.push(cell.trim()); cell = ""; }
      else if (c === '\n' || c === '\r')       {
        if (c === '\r' && n === '\n') i++;
        row.push(cell.trim()); cell = "";
        if (row.some(Boolean)) rows.push(row);
        row = [];
      } else cell += c;
    }
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

function parseBool(v) {
  if (!v) return false;
  return ["true","yes","1","✓","TRUE","YES","True","Yes"].includes(v.trim());
}

function parseISODate(v) {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY
  const d = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (d) return `${d[3]}-${d[2].padStart(2,"0")}-${d[1].padStart(2,"0")}`;
  // Google Sheets date serial (days since 30 Dec 1899)
  const n = parseInt(s);
  if (!isNaN(n) && n > 1000) return new Date((n - 25569) * 86400000).toISOString().split("T")[0];
  return null;
}

async function fetchGuestsFromSheets(url) {
  const csvUrl = normalizeSheetsUrl(url);
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}. Make sure the sheet is published to the web (File → Share → Publish to web).`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  // Row 0 = headers; rows 1+ = data
  // Expected columns: Guest Name | Source | Invitation Date | Briefing Date |
  //   Interview Date | Notes | Offer Made | Assets Created | Assets Shared |
  //   Published to YouTube | Reels 1 Published | Reels 2 Published | Reels 3 Published
  return rows.slice(1).filter(r => r[0]).map((cols, i) => ({
    id:             `sheet-${i}`,
    name:           cols[0] || "Unnamed",
    source:         cols[1] || "",
    invitationDate: parseISODate(cols[2]),
    briefingDate:   parseISODate(cols[3]),
    interviewDate:  parseISODate(cols[4]),
    notes:          cols[5] || "",
    offerMade:      parseBool(cols[6]),
    assetsCreated:  parseBool(cols[7]),
    assetsShared:   parseBool(cols[8]),
    published:      parseBool(cols[9]),
    reels1:         parseBool(cols[10]),
    reels2:         parseBool(cols[11]),
    reels3:         parseBool(cols[12]),
  }));
}

// ─── Notion adapter ───────────────────────────────────────────────────────────
async function fetchGuestsFromNotion(token, dbId) {
  if (!token) throw new Error("Notion token is missing. Open Settings to configure.");
  if (!dbId)  throw new Error("Notion database ID is missing. Open Settings to configure.");
  const client = new Client({ auth: token });
  const results = [];
  let cursor;
  do {
    const r = await client.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
    results.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return results.map(notionPageToGuest);
}

// ─── Universal fetcher ────────────────────────────────────────────────────────
async function fetchGuests(creds) {
  return creds.source === "sheets"
    ? fetchGuestsFromSheets(creds.sheetsUrl)
    : fetchGuestsFromNotion(creds.notionToken, creds.notionDbId);
}

// ─── Stage classification ─────────────────────────────────────────────────────
const STAGES = ["Outreach Sent","Briefing Booked","Briefing Done","Interview Booked","Interview Done","Published"];

function classifyGuest(g) {
  const now = new Date();
  const bd  = g.briefingDate  ? new Date(g.briefingDate  + "T12:00:00") : null;
  const id  = g.interviewDate ? new Date(g.interviewDate + "T12:00:00") : null;
  if (g.published)          return "Published";
  if (id  && id  < now)     return "Interview Done";
  if (id  && id  >= now)    return "Interview Booked";
  if (bd  && bd  < now)     return "Briefing Done";
  if (bd  && bd  >= now)    return "Briefing Booked";
  return "Outreach Sent";
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr + "T12:00:00").getTime()) / 86_400_000);
}

// ─── Dashboard builder ────────────────────────────────────────────────────────
function buildDashboard(rawGuests) {
  const now = new Date();
  const dow = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - (dow + 6) % 7); weekStart.setHours(0,0,0,0);
  const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);

  const guests    = rawGuests.map(g => ({ ...g, stage: classifyGuest(g) }));
  const counts    = Object.fromEntries(STAGES.map(s => [s, 0]));
  const byStage   = Object.fromEntries(STAGES.map(s => [s, []]));
  const overdue   = [];
  let weeklyInterviews = 0, weeklyBriefings = 0, totalActive = 0;

  for (const g of guests) {
    counts[g.stage]++;
    byStage[g.stage].push(g);
    if (g.stage !== "Published") totalActive++;

    const bd  = g.briefingDate  ? new Date(g.briefingDate  + "T12:00:00") : null;
    const id  = g.interviewDate ? new Date(g.interviewDate + "T12:00:00") : null;
    const inv = g.invitationDate ? new Date(g.invitationDate + "T12:00:00") : null;

    if (id  && id  >= weekStart && id  < weekEnd && id  < now) weeklyInterviews++;
    if (bd  && bd  >= weekStart && bd  < weekEnd && bd  < now) weeklyBriefings++;

    if (g.stage === "Briefing Done" && bd) {
      const age = daysSince(g.briefingDate);
      if (age >= 7) overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue:age-7,
        reason:`Briefing done ${age}d ago — no interview scheduled` });
    }
    if (g.stage === "Interview Done" && id) {
      const age = daysSince(g.interviewDate);
      if (age >= 14) overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue:age-14,
        reason:`Interview done ${age}d ago — not yet published` });
    }
    if (g.stage === "Outreach Sent" && inv) {
      const age = daysSince(g.invitationDate);
      if (age >= 14) overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue:age-14,
        reason:`Outreach sent ${age}d ago — no briefing booked` });
    }
  }
  overdue.sort((a,b) => b.daysOverdue - a.daysOverdue);

  const total = guests.length;
  const conv  = total > 0 ? Math.round((counts["Published"] / total) * 100) : 0;
  const oScore = Math.max(0, 100 - overdue.length * 10 - counts["Outreach Sent"] * 2);
  const health = Math.min(100, Math.max(0, Math.round(conv * 0.4 + oScore * 0.6)));

  return {
    lastUpdated: new Date().toISOString(),
    totalGuests: total, totalActive, weeklyInterviews, weeklyBriefings, healthScore: health,
    stages: STAGES.map(name => ({ name, count: counts[name], guests: byStage[name] })),
    overdue,
  };
}

// ─── Notion write helpers ─────────────────────────────────────────────────────
function buildNotionProperties(updates) {
  const p = {};
  if (updates.name          !== undefined) p["Name"]                           = { title:     [{ text:{ content: updates.name } }] };
  if (updates.source        !== undefined) p["Source"]                         = { rich_text: [{ text:{ content: updates.source } }] };
  if (updates.notes         !== undefined) p["Notes"]                          = { rich_text: [{ text:{ content: updates.notes || "" } }] };
  if ("invitationDate" in updates) p["Invitation to briefing"]                 = updates.invitationDate ? { date:{ start: updates.invitationDate } } : { date: null };
  if ("briefingDate"   in updates) p["Briefing"]                               = updates.briefingDate   ? { date:{ start: updates.briefingDate   } } : { date: null };
  if ("interviewDate"  in updates) p["Interview"]                              = updates.interviewDate  ? { date:{ start: updates.interviewDate  } } : { date: null };
  if (updates.offerMade      !== undefined) p["Offer Made"]                    = { checkbox: updates.offerMade };
  if (updates.assetsCreated  !== undefined) p["Assets Created"]                = { checkbox: updates.assetsCreated };
  if (updates.assetsShared   !== undefined) p["Assets Shared"]                 = { checkbox: updates.assetsShared };
  if (updates.published      !== undefined) p["Published Mini-Talk to YouTube"]= { checkbox: updates.published };
  if (updates.reels1         !== undefined) p["Reels & Stories #1 Published"]  = { checkbox: updates.reels1 };
  if (updates.reels2         !== undefined) p["Reels & Stories #2 Published"]  = { checkbox: updates.reels2 };
  if (updates.reels3         !== undefined) p["Reels & Stories #3 Published"]  = { checkbox: updates.reels3 };
  return p;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Test connection — called by setup wizard
app.post("/api/test-connection", async (req, res) => {
  const creds = getCredentials(req);
  try {
    const guests = await fetchGuests(creds);
    res.json({ ok: true, count: guests.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Dashboard data
app.get("/api/dashboard", async (req, res) => {
  const creds = getCredentials(req);
  try {
    const guests = await fetchGuests(creds);
    res.json(buildDashboard(guests));
  } catch (err) {
    console.error("Dashboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create guest (Notion only)
app.post("/api/guests", async (req, res) => {
  const creds = getCredentials(req);
  if (creds.source === "sheets")
    return res.status(400).json({ error: "Adding guests is not supported for Google Sheets. Please add them directly in your sheet." });
  try {
    const props = buildNotionProperties(req.body);
    if (!props["Name"]) return res.status(400).json({ error: "name is required" });
    const client = new Client({ auth: creds.notionToken });
    const page   = await client.pages.create({ parent:{ database_id: creds.notionDbId }, properties: props });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update guest (Notion only)
app.patch("/api/guests/:id", async (req, res) => {
  const creds = getCredentials(req);
  if (creds.source === "sheets")
    return res.status(400).json({ error: "Editing guests is not supported for Google Sheets. Please edit them directly in your sheet." });
  try {
    const client = new Client({ auth: creds.notionToken });
    const page   = await client.pages.update({ page_id: req.params.id, properties: buildNotionProperties(req.body) });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`\n🎙️  Mini-Talks Dashboard → http://localhost:${PORT}\n`));
