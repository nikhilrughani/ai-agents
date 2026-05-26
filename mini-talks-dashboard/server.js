require("dotenv").config();
const express  = require("express");
const { Client } = require("@notionhq/client");
const path   = require("path");
const crypto = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────
const FIREBASE_PROJECT_ID   = process.env.FIREBASE_PROJECT_ID   || "";
const APP_URL               = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const RESEND_API_KEY        = process.env.RESEND_API_KEY        || "";
const FROM_EMAIL            = process.env.FROM_EMAIL            || "hello@nikhilrughani.com";
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID       || "";
const ENFORCE_PLAN          = process.env.ENFORCE_PLAN === "true";

// Stripe webhook needs raw body — parse it before the JSON middleware
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "2mb" }));

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
      // Migration: accounts imported from Notion/Sheets before v2 have source="notion"|"sheets"
      // All guest data is in Firestore now — treat them as "firestore" source
      if (req.creds.source === "notion" || req.creds.source === "sheets") {
        req.creds = { source: "firestore" };
        // Silently fix the stored credentials so this only runs once
        fsSet(`users/${req.uid}/private/credentials`, { source: "firestore" }, token).catch(() => {});
      }
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
    if (source === "firestore") {
      // Start Fresh: just save creds. Import CSV if provided.
      if (csvContent) {
        const rows = parseCSV(csvContent);
        const dataRows = rows.length > 1 && !parseISODate(rows[0][2]) ? rows.slice(1) : rows;
        const guests = dataRows.filter(r => r[0]).map(csvRowToGuest);
        for (const g of guests) { await createGuestInFirestore(req.uid, req.idToken, g); count++; }
      }
    } else if (source === "notion") {
      // Notion one-time import: fetch from Notion, store in Firestore
      // Credentials saved separately for future re-sync (not used for auth)
      if (!notionToken || !notionDbId) return res.status(400).json({ error: "notionToken and notionDbId are required" });
      const guests = await fetchGuestsFromNotion(notionToken, notionDbId);
      for (const g of guests) { await createGuestInFirestore(req.uid, req.idToken, g); count++; }
      // Save credentials so the user can re-sync later
      if (FIREBASE_PROJECT_ID && req.idToken) {
        await fsSet(`users/${req.uid}/private/notionCredentials`, { notionToken, notionDbId }, req.idToken);
      }
    } else if (source === "sheets") {
      // Sheets one-time import: fetch CSV, store in Firestore, forget the sheet URL
      if (!sheetsUrl) return res.status(400).json({ error: "sheetsUrl is required" });
      const guests = await fetchGuestsFromSheets(sheetsUrl);
      for (const g of guests) { await createGuestInFirestore(req.uid, req.idToken, g); count++; }
    } else {
      return res.status(400).json({ error: "Unknown source type." });
    }

    // Always save "firestore" as the stored source — external creds are never persisted after import
    if (FIREBASE_PROJECT_ID && req.idToken) {
      await fsSet(`users/${req.uid}/private/credentials`, { source: "firestore" }, req.idToken);
    }
    res.json({ ok: true, count });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Dashboard data
app.get("/api/dashboard", requireAuth, async (req, res) => {
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

// Status: is this user configured? How many guests do they have?
app.get("/api/status", requireAuth, async (req, res) => {
  const configured = !!req.creds.source;
  let count = 0;
  if (configured) {
    try { count = (await fsList(`users/${req.uid}/guests`, req.idToken)).length; } catch (_) {}
  }
  res.json({ configured, count });
});

// Delete a single guest
app.delete("/api/guests/:id", requireAuth, async (req, res) => {
  try {
    await fsDelete(`users/${req.uid}/guests/${req.params.id}`, req.idToken);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear ALL guests (keeps credentials — use before a re-import)
app.delete("/api/guests", requireAuth, async (req, res) => {
  try {
    const docs = await fsList(`users/${req.uid}/guests`, req.idToken);
    await Promise.all(docs.map(d => fsDelete(`users/${req.uid}/guests/${d.id}`, req.idToken)));
    res.json({ ok: true, deleted: docs.length });
  } catch (err) {
    console.error("Clear error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export all guests as CSV
app.get("/api/export", requireAuth, async (req, res) => {
  try {
    const guests = await fetchGuestsFromFirestore(req.uid, req.idToken);

    const HEADERS = [
      "Guest Name","Source","Invitation Date","Briefing Date","Interview Date","Notes",
      "Offer Made","Assets Created","Assets Shared","Published",
      "Reels 1","Reels 2","Reels 3",
    ];

    function csvCell(v) {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    }

    const rows = [
      HEADERS.map(csvCell).join(","),
      ...guests.map(g => [
        g.name, g.source || "",
        g.invitationDate || "", g.briefingDate || "", g.interviewDate || "",
        g.notes || "",
        g.offerMade     ? "TRUE" : "FALSE",
        g.assetsCreated ? "TRUE" : "FALSE",
        g.assetsShared  ? "TRUE" : "FALSE",
        g.published     ? "TRUE" : "FALSE",
        g.reels1        ? "TRUE" : "FALSE",
        g.reels2        ? "TRUE" : "FALSE",
        g.reels3        ? "TRUE" : "FALSE",
      ].map(csvCell).join(",")),
    ];

    const today = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="mini-talks-guests-${today}.csv"`);
    res.send(rows.join("\r\n"));
  } catch (err) {
    console.error("Export error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Plan middleware (no-op until ENFORCE_PLAN=true + Stripe configured) ────
async function requireActivePlan(req, res, next) {
  // Currently free for everyone — flip ENFORCE_PLAN=true when ready to charge
  if (!ENFORCE_PLAN || !STRIPE_SECRET_KEY || !FIREBASE_PROJECT_ID) return next();
  try {
    const plan = await fsGet(`users/${req.uid}/private/plan`, req.idToken);
    if (plan?.status === "active") return next();
    return res.status(402).json({
      error: "An active plan is required. Please upgrade to continue.",
      upgradeUrl: `${APP_URL}/setup.html#upgrade`,
    });
  } catch (_) { return next(); } // fail open for now
}

// ─── Share snapshot helper ────────────────────────────────────────────────────
async function writeShareSnapshot(uid, token, shareToken) {
  const guests    = await fetchGuestsFromFirestore(uid, token);
  const dashboard = buildDashboard(guests, "firestore");
  await fsSet(`users/${uid}/publicSnapshot/data`, {
    token:         shareToken,
    enabled:       "true",
    updatedAt:     new Date().toISOString(),
    dashboardJson: JSON.stringify(dashboard),
  }, token);
}

// ─── Email helper (Resend) ────────────────────────────────────────────────────
async function sendWelcomeEmail(email) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to:   email,
        subject: "Welcome to Mini-Talks Pipeline 🎙️",
        html: `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#0e0f14;color:#e8eaf0">
  <div style="font-size:2.5rem;margin-bottom:20px">🎙️</div>
  <h1 style="font-size:1.4rem;font-weight:700;margin-bottom:10px;color:#e8eaf0">Welcome to Mini-Talks Pipeline</h1>
  <p style="color:#7a7f96;line-height:1.6;margin-bottom:24px">
    Your account is all set. Track every guest from first outreach through to published — all in one clean dashboard.
  </p>
  <a href="${APP_URL}/setup.html" style="display:inline-block;background:#4bb8d0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-bottom:28px">
    Set Up Your Pipeline →
  </a>
  <hr style="border:none;border-top:1px solid #2a2d3a;margin:24px 0">
  <p style="font-size:.75rem;color:#7a7f96;line-height:1.5">
    Built by <a href="https://nikhilrughani.com" style="color:#4bb8d0">Nikhil Rughani</a><br>
    You're receiving this because you just created an account on Mini-Talks Pipeline.
  </p>
</div>`,
      }),
    });
  } catch (err) {
    console.warn("Welcome email failed:", err.message);
  }
}

// ─── Serve share.html for clean URLs ─────────────────────────────────────────
app.get("/share/:uid/:token", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "share.html")));

// ─── Settings (composite read for the settings panel) ────────────────────────
app.get("/api/settings", requireAuth, async (req, res) => {
  const [notionCreds, shareConfig] = await Promise.all([
    fsGet(`users/${req.uid}/private/notionCredentials`, req.idToken).catch(() => null),
    fsGet(`users/${req.uid}/private/share`,             req.idToken).catch(() => null),
  ]);
  const shareEnabled = shareConfig?.enabled === "true";
  res.json({
    notionConnected: !!notionCreds,
    shareEnabled,
    shareUrl: shareEnabled ? `${APP_URL}/share/${req.uid}/${shareConfig.token}` : null,
    pricingEnabled: !!(STRIPE_SECRET_KEY && STRIPE_PRICE_ID),
  });
});

// ─── Notion re-sync ───────────────────────────────────────────────────────────
app.post("/api/sync/notion", requireAuth, async (req, res) => {
  const creds = await fsGet(`users/${req.uid}/private/notionCredentials`, req.idToken);
  if (!creds?.notionToken || !creds?.notionDbId)
    return res.status(400).json({ error: "No Notion credentials saved. Please re-import via Settings." });
  try {
    const [notionGuests, existingGuests] = await Promise.all([
      fetchGuestsFromNotion(creds.notionToken, creds.notionDbId),
      fetchGuestsFromFirestore(req.uid, req.idToken),
    ]);
    const existingNames = new Set(existingGuests.map(g => g.name.toLowerCase().trim()));
    let added = 0, skipped = 0;
    for (const g of notionGuests) {
      if (existingNames.has(g.name.toLowerCase().trim())) { skipped++; continue; }
      await createGuestInFirestore(req.uid, req.idToken, g);
      added++;
    }
    res.json({ ok: true, added, skipped });
  } catch (err) {
    console.error("Notion sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Share link ───────────────────────────────────────────────────────────────
// Enable / refresh share
app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const existing = await fsGet(`users/${req.uid}/private/share`, req.idToken);
    const shareToken = existing?.token || crypto.randomBytes(24).toString("hex");
    await fsSet(`users/${req.uid}/private/share`,
      { token: shareToken, enabled: "true", createdAt: existing?.createdAt || new Date().toISOString() },
      req.idToken);
    await writeShareSnapshot(req.uid, req.idToken, shareToken);
    res.json({ ok: true, shareUrl: `${APP_URL}/share/${req.uid}/${shareToken}` });
  } catch (err) {
    console.error("Share enable error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Refresh snapshot with latest data (call after editing guests)
app.post("/api/share/refresh", requireAuth, async (req, res) => {
  try {
    const shareConfig = await fsGet(`users/${req.uid}/private/share`, req.idToken);
    if (!shareConfig?.enabled) return res.json({ ok: true, skipped: true });
    await writeShareSnapshot(req.uid, req.idToken, shareConfig.token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disable share
app.delete("/api/share", requireAuth, async (req, res) => {
  try {
    const existing = await fsGet(`users/${req.uid}/private/share`, req.idToken);
    if (existing) {
      await fsSet(`users/${req.uid}/private/share`,
        { ...existing, enabled: "false" }, req.idToken);
    }
    // Clear the public snapshot
    await fsDelete(`users/${req.uid}/publicSnapshot/data`, req.idToken);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Welcome email ────────────────────────────────────────────────────────────
app.post("/api/welcome", requireAuth, async (req, res) => {
  const email = (req.body?.email || "").trim();
  if (!email) return res.status(400).json({ error: "email required" });
  await sendWelcomeEmail(email);
  res.json({ ok: true });
});

// ─── Plan / billing ───────────────────────────────────────────────────────────
app.get("/api/plan", requireAuth, async (req, res) => {
  const pricingEnabled = !!(STRIPE_SECRET_KEY && STRIPE_PRICE_ID);
  if (!FIREBASE_PROJECT_ID) return res.json({ tier: "free", status: "active", pricingEnabled });
  let plan = await fsGet(`users/${req.uid}/private/plan`, req.idToken).catch(() => null);
  if (!plan) {
    plan = { tier: "free", status: "active", createdAt: new Date().toISOString() };
    await fsSet(`users/${req.uid}/private/plan`, plan, req.idToken).catch(() => {});
  }
  res.json({ ...plan, pricingEnabled });
});

// Stripe: create checkout session (only works when STRIPE_SECRET_KEY is set)
app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID)
    return res.status(503).json({ error: "Stripe is not configured on this server." });
  try {
    const Stripe  = require("stripe");
    const stripe  = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: req.body.email || undefined,
      metadata:  { uid: req.uid },
      success_url: `${APP_URL}/?upgraded=1`,
      cancel_url:  `${APP_URL}/setup.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe: webhook handler
// TODO: Firestore write here requires a service account key (FIREBASE_SERVICE_ACCOUNT_JSON)
//       to be added to env vars when ready to enforce paid plans.
app.post("/api/stripe/webhook", async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: "Webhook not configured." });
  const Stripe = require("stripe");
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }
  // Log all events for now; update Firestore plan doc when service account is available
  console.log(`Stripe event: ${event.type}`, event.data.object?.metadata);
  if (event.type === "checkout.session.completed") {
    const { uid } = event.data.object.metadata || {};
    console.log(`✅ Payment completed for uid=${uid} — update plan doc manually or add service account.`);
  }
  if (event.type === "customer.subscription.deleted") {
    const { uid } = event.data.object.metadata || {};
    console.log(`❌ Subscription cancelled for uid=${uid}`);
  }
  res.json({ received: true });
});

app.listen(PORT, () => console.log(`\n🎙️  Mini-Talks Dashboard → http://localhost:${PORT}\n`));
