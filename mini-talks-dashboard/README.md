# 🎙️ Mini-Talks Pipeline Dashboard

Real-time pipeline dashboard for the Mini-Talks talk-show format. Every subscriber gets their own secure login — you can sell access and each user connects their own Notion database.

Auto-refreshes every 60 seconds. Zero ongoing maintenance.

> **Free tier:** Uses **Vercel** (free) for the Express API and **Firebase** free tier (Auth + Firestore) for multi-user logins. No Firebase paid plan or credit card needed.

---

## What's inside

| Layer | Tech | Cost | Purpose |
|---|---|---|---|
| Hosting + API | **Vercel** (free) | $0 | Serves the app and Express API as serverless functions |
| Auth | **Firebase Authentication** (free Spark plan) | $0 | Per-subscriber email + password login |
| Credentials | **Google Firestore** (free Spark plan) | $0 | Stores per-user Notion tokens securely |
| Source | Notion API **or** Google Sheets | $0 | Where your guest data lives |

> **Why Vercel + Firebase instead of Firebase-only?**  
> Firebase Cloud Functions require the Blaze (paid) plan. Vercel's serverless functions are free. Firebase Auth and Firestore remain on the free Spark plan — no billing account or credit card needed.

---

## Pipeline stages

```
Outreach Sent → Briefing Booked → Briefing Done → Interview Booked → Interview Done → Published
```

**Dashboard shows:**
- Count of guests at each stage (colour-coded)
- Overdue follow-up flags (briefing done >7d with no interview, etc.)
- Weekly throughput (interviews + briefings this week)
- Overall pipeline health score (0–100)
- Click any stage to expand the guest list with inline checkbox toggles

---

## Deploy in 4 steps (everything free)

### Step 1 — Create Firebase project (Auth + Firestore only — free Spark plan)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. Name it (e.g. `mini-talks-dashboard`) — **stay on the free Spark plan, no upgrade needed**

Enable two services in the console (both free):

| Console section | Action |
|---|---|
| **Authentication → Sign-in method** | Email/Password → **Enable** |
| **Firestore Database** | Create database → **Production mode** → choose a region |

### Step 2 — Add Firebase config to the app

The client config is **not secret** — it's safe to put in your source code. Firebase security rules protect your data, not the config.

1. Firebase Console → ⚙️ **Project settings** → scroll to **Your apps**
2. Click **</>** (Web app) → give it a nickname → click **Register app**
3. Copy the `firebaseConfig` values
4. Paste them into **`public/firebase-config.js`**:

```js
window.firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "mini-talks-dashboard.firebaseapp.com",
  projectId:         "mini-talks-dashboard",
  storageBucket:     "mini-talks-dashboard.firebasestorage.app",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",
};
```

### Step 3 — Generate a Firebase service account (server secret)

The server needs this to verify login tokens and save credentials to Firestore.

1. Firebase Console → ⚙️ **Project settings** → **Service accounts** tab
2. Click **Generate new private key** → **Generate key** → download the JSON file
3. Open the JSON file in a text editor → **select all and copy** (it's one JSON object)

You'll paste this in Step 4 as `FIREBASE_SERVICE_ACCOUNT`.

> Keep this JSON private. Do not commit it to git. The `.gitignore` already excludes `.env`.

### Step 4 — Deploy to Vercel (free)

```bash
# Install Vercel CLI if you don't have it
npm install -g vercel

# From the mini-talks-dashboard folder:
npm install
vercel
```

When Vercel asks if you want to set up environment variables, add:

| Key | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Paste the entire service account JSON |

Your live URL appears at the end:
```
✅  Production: https://mini-talks-dashboard-xxx.vercel.app
```

#### Alternative: deploy via Vercel dashboard (no CLI needed)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import the repo
3. Set **Root Directory** to `mini-talks-dashboard`
4. Under **Environment Variables**, add `FIREBASE_SERVICE_ACCOUNT` → paste the JSON
5. Click **Deploy**

#### Add/update env vars later

```bash
vercel env add FIREBASE_SERVICE_ACCOUNT
```

---

## User flow

1. User visits your Vercel URL → if not logged in, redirected to **`/login.html`**
2. Sign up with email + password (or sign in if returning)
3. First visit after signup → redirected to **`/setup.html`** (no Notion credentials yet)
4. Setup wizard: choose Notion or Google Sheets → enter credentials → **Test & Save**
5. Credentials saved securely to Firestore → redirected to the **dashboard**
6. Dashboard auto-refreshes every 60 seconds

---

## Notion database requirements

Your Notion database must have these exact property names:

| Property | Type |
|---|---|
| Guest Name | Title |
| Source | Text |
| Invitation Date | Date |
| Briefing Date | Date |
| Interview Date | Date |
| Notes | Text |
| Offer Made | Checkbox |
| Assets Created | Checkbox |
| Assets Shared | Checkbox |
| Published Mini-Talk to YouTube | Checkbox |
| Reels & Stories #1 Published | Checkbox |
| Reels & Stories #2 Published | Checkbox |
| Reels & Stories #3 Published | Checkbox |

**Notion integration setup:**
1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → copy the token
2. In Notion: open your database → `···` → Connections → select your integration
3. Enter the token and database ID in the setup wizard

---

## 📊 Google Sheets (read-only mode)

Your spreadsheet must have these headers in **row 1, in this order**:

| Col | Header |
|-----|--------|
| A | Guest Name |
| B | Source |
| C | Invitation Date |
| D | Briefing Date |
| E | Interview Date |
| F | Notes |
| G | Offer Made |
| H | Assets Created |
| I | Assets Shared |
| J | Published to YouTube |
| K | Reels 1 Published |
| L | Reels 2 Published |
| M | Reels 3 Published |

- Dates: `YYYY-MM-DD` format (or `DD/MM/YYYY`)
- Booleans: `TRUE` / `FALSE`
- Publish the sheet: **File → Share → Publish to web → CSV**

Google Sheets is read-only — the "Add Guest" button is hidden in this mode.

---

## Selling subscriptions

Each subscriber gets their own Firebase Auth account.

| Option | How |
|---|---|
| **Self-service** | Subscribers sign up at `/login.html` — works immediately |
| **Invite only** | Disable public signups in Firebase Auth → create accounts manually in the console |
| **Paid gating** | Add a Stripe webhook that calls Firebase Admin SDK to create accounts after payment |

Subscriber Notion tokens are stored in their own Firestore document — only the server (via Admin SDK) and the subscriber themselves can access it.

---

## Local development (no Firebase needed)

For local dev without a Firebase project, add a `.env` file:

```bash
cp .env.example .env
# Fill in NOTION_TOKEN and NOTION_DATABASE_ID
npm run dev
# Open http://localhost:3000
```

When `FIREBASE_SERVICE_ACCOUNT` is not set, the server skips auth and reads credentials from `.env` directly. The browser pages will show an error until you also fill in `public/firebase-config.js` (required for the login UI).

To test the full auth flow locally, set `FIREBASE_SERVICE_ACCOUNT` in `.env` and fill in `public/firebase-config.js`.

---

## Overdue rules

| Situation | Flagged after |
|---|---|
| Outreach sent, no briefing booked | 14 days |
| Briefing done, no interview scheduled | 7 days |
| Interview done, not published | 14 days |

---

## File structure

```
mini-talks-dashboard/
├── public/                    ← Static frontend
│   ├── index.html             ← Dashboard (auth-gated, auto-refresh)
│   ├── login.html             ← Sign in / Sign up / Password reset
│   ├── setup.html             ← Data source credentials wizard
│   └── firebase-config.js    ← ← FILL THIS IN (your Firebase project values)
│
├── server.js                  ← Express API (Notion proxy + auth verification)
├── package.json               ← Dependencies inc. firebase-admin
├── vercel.json                ← Vercel deployment config
│
├── functions/                 ← Firebase Functions version (needs Blaze plan)
│   ├── index.js               ← (alternative if you upgrade to Blaze later)
│   └── package.json
│
├── firebase.json              ← Firebase config (Hosting + Functions if used)
├── .firebaserc                ← Firebase project ID
├── firestore.rules            ← Per-user data isolation rules
└── .env.example               ← Copy to .env for local dev
```
