# 🎙️ Mini-Talks Pipeline Dashboard

Real-time pipeline dashboard for the Mini-Talks talk-show format. Built on **Firebase** so every subscriber gets their own secure login — you can sell access and each user connects their own Notion database.

Auto-refreshes every 60 seconds. Zero ongoing maintenance.

---

## What's inside

| Layer | Tech | Purpose |
|---|---|---|
| Hosting | Firebase Hosting | Serves the HTML/CSS/JS frontend |
| API | Firebase Cloud Functions (Node.js) | Proxies Notion / Sheets API calls, enforces auth |
| Auth | Firebase Authentication | Per-subscriber email + password login |
| Data | Google Firestore | Stores per-user Notion credentials securely |
| Source | Notion API **or** Google Sheets | Where your guest data lives |

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

## First-time setup (5 minutes)

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. Name it (e.g. `mini-talks-dashboard`)

### 2. Enable services in the Firebase console

| Console section | What to enable |
|---|---|
| **Authentication → Sign-in method** | Email/Password → Enable |
| **Firestore Database** | Create database → Start in **production mode** → choose region |
| **Functions** | Upgrade to **Blaze plan** (pay-as-you-go — free tier covers typical usage) |

### 3. Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### 4. Wire up your project ID

Edit `.firebaserc` — replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`:

```json
{
  "projects": {
    "default": "your-firebase-project-id"
  }
}
```

### 5. Install function dependencies

```bash
cd functions && npm install && cd ..
```

### 6. Deploy everything

```bash
firebase deploy
```

Your app URL prints at the end:
```
✔  Hosting URL: https://your-project-id.web.app
```

---

## User flow

1. User visits your URL → if not logged in, redirected to **`/login.html`**
2. Sign up with email + password (or sign in if returning)
3. First visit after signup → redirected to **`/setup.html`** (no Notion credentials yet)
4. Setup wizard: choose Notion or Google Sheets → enter credentials → **Test & Save**
5. Redirected to the **dashboard** — auto-refreshes every 60 seconds

Credentials are saved to `Firestore: users/{uid}/private/credentials`.  
Firestore rules ensure only the account owner can access their own data.

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

## Local development

```bash
firebase emulators:start
# Open http://localhost:5000
```

The emulator UI (Auth + Firestore inspector) is at `http://localhost:4000`.

---

## Selling subscriptions

Each subscriber gets their own Firebase Auth account.

| Option | How |
|---|---|
| **Self-service** | Subscribers sign up at `/login.html` — free |
| **Invite only** | Disable public signups in Firebase Auth → create accounts manually |
| **Paid gating** | Add a Stripe webhook that calls Firebase Admin to create accounts after payment |

Subscriber Notion tokens never leave their own Firestore document — not even you as admin can read them.

---

## Overdue rules

| Situation | Flagged after |
|---|---|
| Outreach sent, no briefing booked | 14 days |
| Briefing done, no interview scheduled | 7 days |
| Interview done, not published | 14 days |

---

## Cost estimate (Firebase Blaze plan)

For 50 subscribers checking the dashboard a few times a day — **effectively $0/month**.

| Service | Free tier | Typical cost |
|---|---|---|
| Hosting | 10 GB / 360 MB/day | ~$0 |
| Functions | 2M invocations/month | ~$0–$1 |
| Firestore | 1 GB / 50K reads/day | ~$0 |
| Auth | Unlimited MAUs | $0 |

---

## File structure

```
mini-talks-dashboard/
├── public/                  ← Firebase Hosting (frontend)
│   ├── index.html           ← Dashboard (auth-gated, auto-refresh)
│   ├── login.html           ← Sign in / Sign up / Password reset
│   └── setup.html           ← Data source credentials wizard
│
├── functions/               ← Cloud Functions (Node.js API)
│   ├── index.js             ← /api/dashboard · /api/guests · /api/setup
│   └── package.json
│
├── firebase.json            ← Hosting + Functions + Emulator config
├── .firebaserc              ← Your Firebase project ID ← EDIT THIS
├── firestore.rules          ← Per-user data isolation
└── firestore.indexes.json
```
