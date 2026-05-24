# 🎙️ Mini-Talks Pipeline Dashboard

A real-time pipeline dashboard for the **Mini-Talk Method** — track guests from Outreach through to Published, auto-refreshing every 60 seconds.

Supports **Notion** (full read + write) and **Google Sheets** (read-only view).

---

## 🚀 Deploy your own copy (recommended)

Each person gets their own private dashboard on Vercel — free, no server to manage.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnikhilrughani%2Fai-agents&root-directory=mini-talks-dashboard&project-name=mini-talks-dashboard&repository-name=mini-talks-dashboard)

1. Click the button above
2. Log in to Vercel (free account)
3. Click **Deploy** — no environment variables needed upfront
4. Once deployed, visit your new URL — the **setup wizard** will guide you through connecting your data source

---

## 🗄️ Option A — Connect Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration** → copy the token
2. Open your Mini-Talks database in Notion → **···** menu → **Connections** → add your integration
3. Copy your database ID from the URL (the 32-character hex string)
4. Paste both into the dashboard setup wizard

## 📊 Option B — Connect Google Sheets

Your sheet must have these column headers **in row 1, in this order**:

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

- Dates: `YYYY-MM-DD` format
- Checkboxes: `TRUE` / `FALSE`

Then publish the sheet: **File → Share → Publish to web → CSV** and paste the URL into the setup wizard.

> **Note:** Google Sheets is read-only. Add and edit guests directly in your sheet; the dashboard reflects changes on the next refresh.

---

## 💻 Run locally

```bash
git clone https://github.com/nikhilrughani/ai-agents.git
cd ai-agents/mini-talks-dashboard
npm install
npm start
# Open http://localhost:3000 — setup wizard runs on first visit
```

Or double-click **`Launch Mini-Talks.command`** (Mac only).

---

## Pipeline stages

**Outreach Sent → Briefing Booked → Briefing Done → Interview Booked → Interview Done → Published**

Stage is calculated automatically from your dates and the Published checkbox — no manual status field needed.
