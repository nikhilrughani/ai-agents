require("dotenv").config();
const express = require("express");
const { Client } = require("@notionhq/client");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" })); // allow CSV payloads

// ─── Firebase config ──────────────────────────────────────────────────────────
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";

let _verifyToken = null;
async function verifyFirebaseToken(token) {
  if (!_verifyToken) {
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    const jwks = createRemoteJWKSet(
      new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
    );
    _verifyToken = async (t) => {
      const { payload } = await jwtVerify(t, jwks, {
        issuer:   `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
      });
      return payload;
    };
  }
  return _verifyToken(token);
}

// ─── Firestore REST helpers ───────────────────────────────────────────────────
const FS = () =>
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Convert Firestore field value → JS value
function fsVal(v) {
  if (v === undefined || v === null) return null;
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue    !== undefined) return null;
  return null;
}

// Convert JS value → Firestore field value
function toFsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  return { stringValue: String(v) };
}

// Convert Firestore document → plain object
function docToObj(doc) {
  if (!doc?.fields) return null;
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = fsVal(v);
  return obj;
}

// Convert plain object → Firestore fields map
function objToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFsVal(v);
  return fields;
}

// GET a single document
async function fsGet(docPath, token) {
  const res = await fetch(`${FS()}/${docPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET failed (${res.status})`);
  return docToObj(await res.json());
}

// SET (create or overwrite) a document
async function fsSet(docPath, data, token) {
  const res = await fetch(`${FS()}/${docPath}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: objToFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore SET failed (${res.status})`);
  return docToObj(await res.json());
}

// LIST documents in a collection (up to 300)
async function fsList(collPath, token) {
  const res = await fetch(`${FS()}/${collPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Firestore LIST failed (${res.status})`);
  const body = await res.json();
  if (!body.documents) return [];
  return body.documents.map(doc => ({
    ...docToObj(doc),
    id: doc.name.split("/").pop(),
  }));
}

// CREATE a document with auto-generated ID
async function fsCreate(collPath, data, token) {
  const res = await fetch(`${FS()}/${collPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: objToFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore CREATE failed (${res.status})`);
  const doc = await res.json();
  return { ...docToObj(doc), id: doc.name.split("/").pop() };
}

// UPDATE specific fields in a document (merge patch)
async function fsUpdate(docPath, data, token) {
  // Build updateMask from keys
  const fieldPaths = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await fetch(`${FS()}/${docPath}?${fieldPaths}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: objToFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore UPDATE failed (${res.status})`);
  return docToObj(await res.json());
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (FIREBASE_PROJECT_ID) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required. Please log in." });
    }
    try {
      const token   = auth.slice(7);
      const payload = await verifyFirebaseToken(token);
      req.uid     = payload.sub;
      req.idToken = token;
      req.creds   = (await fsGet(`users/${req.uid}/private/credentials`, token)) || {};
      return next();
    } catch (err) {
      console.error("Auth error:", err.message);
      return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
    }
  }
  // Local dev fallback
  req.uid   = "local";
  req.creds = {
    source:      (process.env.DATA_SOURCE || "notion").toLowerCase(),
    notionToken: process.env.NOTION_TOKEN       || "",
    notionDbId:  process.env.NOTION_DATABASE_ID || "",
    sheetsUrl:   process.env.SHEETS_URL         || "",
  };
  next();
}

// ─── Guest shape helpers ──────────────────────────────────────────────────────
function emptyGuest(overrides = {}) {
  return {
    name: "Unnamed", source: "", notes: "",
    invitationDate: null, briefingDate: null, interviewDate: null,
    published: false, offerMade: false,
    assetsCreated: false, assetsShared: false,
    reels1: false, reels2: false, reels3: false,
    ...overrides,
  };
}

// ─── Firestore guest adapter ──────────────────────────────────────────────────
async function fetchGuestsFromFirestore(uid, token) {
  const docs = await fsList(`users/${uid}/guests`, token);
  return docs.map(d => emptyGuest(d));
}

async function createGuestInFirestore(uid, token, data) {
  const doc = await fsCreate(`users/${uid}/guests`, emptyGuest(data), token);
  return emptyGuest(doc);
}

async function updateGuestInFirestore(uid, token, guestId, updates) {
  const doc = await fsUpdate(`users/${uid}/guests/${guestId}`, updates, token);
  return emptyGuest({ ...doc, id: guestId });
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

function notionPageToGuest(page) {
  const bd  = getDate(page, "Briefing Date")   || getDate(page, "Briefing");
  const id  = getDate(page, "Interview Date")  || getDate(page, "Interview");
  const inv = getDate(page, "Invitation Date") || getDate(page, "Invitation to briefing");
  return {
    id:             page.id,
    name:           getText(page, "Guest Name") || getText(page, "Name") || "Unnamed",
    source:         getText(page, "Source") || "",
    notes:          getText(page, "Notes")  || "",
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

// ─── Google Sheets adapter ────────────────────────────────────────────────────
function normalizeSheetsUrl(raw) {
  if (!raw) throw new Error("No Google Sheets URL provided");
  if (raw.includes("output=csv") || raw.includes("format=csv")) return raw;
  const m = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw.trim()))
    return `https://docs.google.com/spreadsheets/d/${raw.trim()}/export?format=csv`;
  throw new Error("Couldn't recognise the Google Sheets URL.");
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
      if      (c === '"')                { inQ = true; }
      else if (c === ',')                { row.push(cell.trim()); cell = ""; }
      else if (c === '\n' || c === '\r') {
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
  return ["true","yes","1","✓","TRUE","YES","True","Yes"].includes((v||"").trim());
}

function parseISODate(v) {
  if (!v?.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (d) return `${d[3]}-${d[2].padStart(2,"0")}-${d[1].padStart(2,"0")}`;
  const n = parseInt(s);
  if (!isNaN(n) && n > 1000) return new Date((n - 25569) * 86400000).toISOString().split("T")[0];
  return null;
}

function csvRowToGuest(cols) {
  return emptyGuest({
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
  });
}

async function fetchGuestsFromSheets(url) {
  const csvUrl = normalizeSheetsUrl(url);
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}. Make sure the sheet is published to the web.`);
  const rows = parseCSV(await res.text());
  if (rows.length < 2) return [];
  return rows.slice(1).filter(r => r[0]).map((cols, i) =>
    ({ ...csvRowToGuest(cols), id: `sheet-${i}` })
  );
}

async function fetchGuests(creds, uid, token) {
  if (creds.source === "firestore") return fetchGuestsFromFirestore(uid, token);
  if (creds.source === "sheets")    return fetchGuestsFromSheets(creds.sheetsUrl);
  return fetchGuestsFromNotion(creds.notionToken, creds.notionDbId);
}

// ─── Stage classification ─────────────────────────────────────────────────────
const STAGES = ["Outreach Sent","Briefing Booked","Briefing Done","Interview Booked","Interview Done","Published"];

function classifyGuest(g) {
  const now = new Date();
  const bd  = g.briefingDate  ? new Date(g.briefingDate  + "T12:00:00") : null;
  const id  = g.interviewDate ? new Date(g.interviewDate + "T12:00:00") : null;
  if (g.published)       return "Published";
  if (id && id < now)    return "Interview Done";
  if (id && id >= now)   return "Interview Booked";
  if (bd && bd < now)    return "Briefing Done";
  if (bd && bd >= now)   return "Briefing Booked";
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
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - (dow + 6) % 7); weekStart.setHours(0,0,0,0);
  const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);

  const guests  = rawGuests.map(g => ({ ...g, stage: classifyGuest(g) }));
  const counts  = Object.fromEntries(STAGES.map(s => [s, 0]));
  const byStage = Object.fromEntries(STAGES.map(s => [s, []]));
  const overdue = [];
  let weeklyInterviews = 0, weeklyBriefings = 0, totalActive = 0;

  for (const g of guests) {
    counts[g.stage]++; byStage[g.stage].push(g);
    if (g.stage !== "Published") totalActive++;
    const bd  = g.briefingDate   ? new Date(g.briefingDate  + "T12:00:00") : null;
    const id  = g.interviewDate  ? new Date(g.interviewDate + "T12:00:00") : null;
    const inv = g.invitationDate ? new Date(g.invitationDate+ "T12:00:00") : null;
    if (id  && id  >= weekStart && id  < weekEnd && id  < now) weeklyInterviews++;
    if (bd  && bd  >= weekStart && bd  < weekEnd && bd  < now) weeklyBriefings++;
    if (g.stage === "Briefing Done"  && bd && daysSince(g.briefingDate)  >= 7)
      overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue: daysSince(g.briefingDate) - 7,  reason:`Briefing done ${daysSince(g.briefingDate)}d ago — no interview scheduled` });
    if (g.stage === "Interview Done" && id && daysSince(g.interviewDate) >= 14)
      overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue: daysSince(g.interviewDate) - 14, reason:`Interview done ${daysSince(g.interviewDate)}d ago — not yet published` });
    if (g.stage === "Outreach Sent"  && inv && daysSince(g.invitationDate) >= 14)
      overdue.push({ name:g.name, stage:g.stage, id:g.id, daysOverdue: daysSince(g.invitationDate) - 14, reason:`Outreach sent ${daysSince(g.invitationDate)}d ago — no briefing booked` });
  }
  overdue.sort((a,b) => b.daysOverdue - a.daysOverdue);

  const total  = guests.length;
  const conv   = total > 0 ? Math.round((counts["Published"] / total) * 100) : 0;
  const oScore = Math.max(0, 100 - overdue.length * 10 - counts["Outreach Sent"] * 2);
  const health = Math.min(100, Math.max(0, Math.round(conv * 0.4 + oScore * 0.6)));

  return {
    lastUpdated: new Date().toISOString(), totalGuests: total, totalActive,
    weeklyInterviews, weeklyBriefings, healthScore: health,
    readOnly: source === "sheets",
    stages: STAGES.map(name => ({ name, count: counts[name], guests: byStage[name] })),
    overdue,
  };
}

// ─── Notion write helpers ─────────────────────────────────────────────────────
function buildNotionProperties(updates) {
  const p = {};
  if (updates.name         !== undefined) p["Guest Name"]                      = { title:     [{ text:{ content: updates.name } }] };
  if (updates.source       !== undefined) p["Source"]                          = { rich_text: [{ text:{ content: updates.source } }] };
  if (updates.notes        !== undefined) p["Notes"]                           = { rich_text: [{ text:{ content: updates.notes||"" } }] };
  if ("invitationDate" in updates) p["Invitation Date"]                        = updates.invitationDate ? { date:{ start:updates.invitationDate } } : { date:null };
  if ("briefingDate"   in updates) p["Briefing Date"]                          = updates.briefingDate   ? { date:{ start:updates.briefingDate   } } : { date:null };
  if ("interviewDate"  in updates) p["Interview Date"]                         = updates.interviewDate  ? { date:{ start:updates.interviewDate  } } : { date:null };
  if (updates.offerMade     !== undefined) p["Offer Made"]                     = { checkbox: updates.offerMade };
  if (updates.assetsCreated !== undefined) p["Assets Created"]                 = { checkbox: updates.assetsCreated };
  if (updates.assetsShared  !== undefined) p["Assets Shared"]                  = { checkbox: updates.assetsShared };
  if (updates.published     !== undefined) p["Published Mini-Talk to YouTube"] = { checkbox: updates.published };
  if (updates.reels1        !== undefined) p["Reels & Stories #1 Published"]   = { checkbox: updates.reels1 };
  if (updates.reels2        !== undefined) p["Reels & Stories #2 Published"]   = { checkbox: updates.reels2 };
  if (updates.reels3        !== undefined) p["Reels & Stories #3 Published"]   = { checkbox: updates.reels3 };
  return p;
}

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) =>
  res.json({ ok: true, mode: FIREBASE_PROJECT_ID ? "firebase" : "env" }));

// Save credentials + optional CSV import
app.post("/api/setup", requireAuth, async (req, res) => {
  const { source, notionToken, notionDbId, sheetsUrl, csvContent } = req.body;
  if (!source) return res.status(400).json({ error: "source is required" });

  const creds = { source };

  if (source === "firestore") {
    // No external credentials needed — guests live in Firestore
    if (FIREBASE_PROJECT_ID && req.idToken) {
      await fsSet(`users/${req.uid}/private/credentials`, creds, req.idToken);
    }
    // If CSV provided, import it
    let count = 0;
    if (csvContent) {
      const rows = parseCSV(csvContent);
      const dataRows = rows.length > 1 && !parseISODate(rows[0][2]) ? rows.slice(1) : rows;
      const guests = dataRows.filter(r => r[0]).map(csvRowToGuest);
      for (const g of guests) {
        await createGuestInFirestore(req.uid, req.idToken, g);
        count++;
      }
    }
    return res.json({ ok: true, count, message: csvContent ? `Imported ${count} guests` : "Ready to go!" });
  }

  if (source === "notion") {
    if (!notionToken || !notionDbId) return res.status(400).json({ error: "notionToken and notionDbId are required" });
    creds.notionToken = notionToken; creds.notionDbId = notionDbId;
  } else if (source === "sheets") {
    if (!sheetsUrl) return res.status(400).json({ error: "sheetsUrl is required" });
    creds.sheetsUrl = sheetsUrl;
  }

  try {
    const guests = await fetchGuests(creds, req.uid, req.idToken);
    if (FIREBASE_PROJECT_ID && req.idToken) {
      await fsSet(`users/${req.uid}/private/credentials`, creds, req.idToken);
    }
    res.json({ ok: true, count: guests.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Dashboard data
app.get("/api/dashboard", requireAuth, async (req, res) => {
  // No credentials saved yet → tell the client to redirect to setup
  if (!req.creds.source && !req.creds.notionToken && !req.creds.sheetsUrl) {
    return res.status(400).json({ error: "No data source configured." });
  }
  try {
    const guests = await fetchGuests(req.creds, req.uid, req.idToken);
    res.json(buildDashboard(guests, req.creds.source));
  } catch (err) {
    console.error("Dashboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create guest
app.post("/api/guests", requireAuth, async (req, res) => {
  if (req.creds.source === "sheets")
    return res.status(400).json({ error: "Adding guests is not supported for Google Sheets." });
  try {
    if (req.creds.source === "firestore") {
      const guest = await createGuestInFirestore(req.uid, req.idToken, req.body);
      return res.json(guest);
    }
    // Notion
    const props = buildNotionProperties(req.body);
    if (!props["Guest Name"]) return res.status(400).json({ error: "name is required" });
    const client = new Client({ auth: req.creds.notionToken });
    const page   = await client.pages.create({ parent:{ database_id: req.creds.notionDbId }, properties: props });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update guest
app.patch("/api/guests/:id", requireAuth, async (req, res) => {
  if (req.creds.source === "sheets")
    return res.status(400).json({ error: "Editing guests is not supported for Google Sheets." });
  try {
    if (req.creds.source === "firestore") {
      const guest = await updateGuestInFirestore(req.uid, req.idToken, req.params.id, req.body);
      return res.json({ ...guest, id: req.params.id });
    }
    // Notion
    const client = new Client({ auth: req.creds.notionToken });
    const page   = await client.pages.update({ page_id: req.params.id, properties: buildNotionProperties(req.body) });
    res.json(notionPageToGuest(page));
  } catch (err) {
    console.error("Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`\n🎙️  Mini-Talks Dashboard → http://localhost:${PORT}\n`));
