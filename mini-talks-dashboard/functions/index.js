/**
 * Mini-Talks Dashboard — Cloud Functions backend
 *
 * Handles:
 *  - Firebase Auth token verification on every request
 *  - Reading per-user Notion / Sheets credentials from Firestore
 *  - All dashboard data + CRUD endpoints
 *
 * Deployed as a single Firebase HTTPS Function called "api".
 * Firebase Hosting rewrites /api/** → this function.
 */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const { Client } = require("@notionhq/client");

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────
// Every route (except /api/health) requires a valid Firebase ID token.
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required. Please log in." });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    req.uid = decoded.uid;
    // Load user's data source credentials from Firestore
    const snap = await db.doc(`users/${req.uid}/private/credentials`).get();
    req.creds = snap.exists ? snap.data() : {};
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
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

// ─── Notion adapter ───────────────────────────────────────────────────────────
// Property names match the user's exact Notion database schema.
function notionPageToGuest(page) {
  const bd  = getDate(page, "Briefing Date");
  const id  = getDate(page, "Interview Date");
  const inv = getDate(page, "Invitation Date");
  return {
    id:             page.id,
    name:           getText(page, "Guest Name") || getText(page, "Name") || "Unnamed",
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

async function fetchGuestsFromNotion(token, dbId) {
  if (!token) throw new Error("Notion token not configured. Please visit Settings.");
  if (!dbId)  throw new Error("Notion database ID not configured. Please visit Settings.");
  const client = new Client({ auth: token });
  const results = [];
  let cursor;
  do {
    const r = await client.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return results.map(notionPageToGuest);
}

// ─── Google Sheets adapter ────────────────────────────────────────────────────
function normalizeSheetsUrl(raw) {
  if (!raw) throw new Error("No Google Sheets URL provided");
  if (raw.includes("output=csv") || raw.includes("format=csv")) return raw;
  const m = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw.trim()))
    return `https://docs.google.com/spreadsheets/d/${raw.trim()}/export?format=csv`;
  throw new Error("Couldn't recognise the Google Sheets URL. Use the full URL or a publish-to-web CSV link.");
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
  const d = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (d) return `${d[3]}-${d[2].padStart(2,"0")}-${d[1].padStart(2,"0")}`;
  const n = parseInt(s);
  if (!isNaN(n) && n > 1000) return new Date((n - 25569) * 86400000).toISOString().split("T")[0];
  return null;
}

async function fetchGuestsFromSheets(url) {
  const csvUrl = normalizeSheetsUrl(url);
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}. Make sure the sheet is published to the web (File → Share → Publish to web → CSV).`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
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

async function fetchGuests(creds) {
  if (creds.source === "sheets") return fetchGuestsFromSheets(creds.sheetsUrl);
  return fetchGuestsFromNotion(creds.notionToken, creds.notionDbId);
}

// ─── Stage classification ─────────────────────────────────────────────────────
const STAGES = [
  "Outreach Sent",
  "Briefing Booked",
  "Briefing Done",
  "Interview Booked",
  "Interview Done",
  "Published",
];

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
function buildDashboard(rawGuests, source) {
  const now = new Date();
  const dow = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - (dow + 6) % 7);
  weekStart.setHours(0,0,0,0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const guests  = rawGuests.map(g => ({ ...g, stage: classifyGuest(g) }));
  const counts  = Object.fromEntries(STAGES.map(s => [s, 0]));
  const byStage = Object.fromEntries(STAGES.map(s => [s, []]));
  const overdue = [];
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
      if (age >= 7) overdue.push({
        name: g.name, stage: g.stage, id: g.id, daysOverdue: age - 7,
        reason: `Briefing done ${age}d ago — no interview scheduled`,
      });
    }
    if (g.stage === "Interview Done" && id) {
      const age = daysSince(g.interviewDate);
      if (age >= 14) overdue.push({
        name: g.name, stage: g.stage, id: g.id, daysOverdue: age - 14,
        reason: `Interview done ${age}d ago — not yet published`,
      });
    }
    if (g.stage === "Outreach Sent" && inv) {
      const age = daysSince(g.invitationDate);
      if (age >= 14) overdue.push({
        name: g.name, stage: g.stage, id: g.id, daysOverdue: age - 14,
        reason: `Outreach sent ${age}d ago — no briefing booked`,
      });
    }
  }
  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const total = guests.length;
  const conv  = total > 0 ? Math.round((counts["Published"] / total) * 100) : 0;
  const oScore = Math.max(0, 100 - overdue.length * 10 - counts["Outreach Sent"] * 2);
  const health = Math.min(100, Math.max(0, Math.round(conv * 0.4 + oScore * 0.6)));

  return {
    lastUpdated: new Date().toISOString(),
    totalGuests: total,
    totalActive,
    weeklyInterviews,
    weeklyBriefings,
    healthScore: health,
    readOnly: source === "sheets",
    stages: STAGES.map(name => ({ name, count: counts[name], guests: byStage[name] })),
    overdue,
  };
}

// ─── Notion write helpers ─────────────────────────────────────────────────────
function buildNotionProperties(updates) {
  const p = {};
  if (updates.name       !== undefined) p["Guest Name"]                        = { title:     [{ text: { content: updates.name } }] };
  if (updates.source     !== undefined) p["Source"]                            = { rich_text: [{ text: { content: updates.source } }] };
  if (updates.notes      !== undefined) p["Notes"]                             = { rich_text: [{ text: { content: updates.notes || "" } }] };
  if ("invitationDate" in updates) p["Invitation Date"]                        = updates.invitationDate ? { date: { start: updates.invitationDate } } : { date: null };
  if ("briefingDate"   in updates) p["Briefing Date"]                          = updates.briefingDate   ? { date: { start: updates.briefingDate   } } : { date: null };
  if ("interviewDate"  in updates) p["Interview Date"]                         = updates.interviewDate  ? { date: { start: updates.interviewDate  } } : { date: null };
  if (updates.offerMade     !== undefined) p["Offer Made"]                     = { checkbox: updates.offerMade };
  if (updates.assetsCreated !== undefined) p["Assets Created"]                 = { checkbox: updates.assetsCreated };
  if (updates.assetsShared  !== undefined) p["Assets Shared"]                  = { checkbox: updates.assetsShared };
  if (updates.published     !== undefined) p["Published Mini-Talk to YouTube"] = { checkbox: updates.published };
  if (updates.reels1        !== undefined) p["Reels & Stories #1 Published"]   = { checkbox: updates.reels1 };
  if (updates.reels2        !== undefined) p["Reels & Stories #2 Published"]   = { checkbox: updates.reels2 };
  if (updates.reels3        !== undefined) p["Reels & Stories #3 Published"]   = { checkbox: updates.reels3 };
  return p;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no auth required (used by hosting to confirm function is alive)
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// Save credentials — writes to Firestore, verifies connection first
app.post("/api/setup", requireAuth, async (req, res) => {
  const { source, notionToken, notionDbId, sheetsUrl } = req.body;
  if (!source) return res.status(400).json({ error: "source is required" });

  const creds = { source };
  if (source === "notion") {
    if (!notionToken || !notionDbId)
      return res.status(400).json({ error: "notionToken and notionDbId are required" });
    creds.notionToken = notionToken;
    creds.notionDbId  = notionDbId;
  } else {
    if (!sheetsUrl) return res.status(400).json({ error: "sheetsUrl is required" });
    creds.sheetsUrl = sheetsUrl;
  }

  // Test connection before saving
  try {
    const guests = await fetchGuests(creds);
    // Persist to Firestore
    await db.doc(`users/${req.uid}/private/credentials`).set(creds);
    res.json({ ok: true, count: guests.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Dashboard data
app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const guests = await fetchGuests(req.creds);
    res.json(buildDashboard(guests, req.creds.source));
  } catch (err) {
    console.error("Dashboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create guest (Notion only)
app.post("/api/guests", requireAuth, async (req, res) => {
  if (req.creds.source === "sheets")
    return res.status(400).json({ error: "Adding guests is not supported for Google Sheets. Please add them directly in your sheet." });
  try {
    const props = buildNotionProperties(req.body);
    if (!props["Guest Name"]) return res.status(400).json({ error: "name is required" });
    const client = new Client({ auth: req.creds.notionToken });
    const page   = await client.pages.create({
      parent: { database_id: req.creds.notionDbId },
      properties: props,
    });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update guest (Notion only)
app.patch("/api/guests/:id", requireAuth, async (req, res) => {
  if (req.creds.source === "sheets")
    return res.status(400).json({ error: "Editing guests is not supported for Google Sheets. Please edit them directly in your sheet." });
  try {
    const client = new Client({ auth: req.creds.notionToken });
    const page   = await client.pages.update({
      page_id: req.params.id,
      properties: buildNotionProperties(req.body),
    });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────
exports.api = onRequest({ region: "us-central1", memory: "256MiB" }, app);
