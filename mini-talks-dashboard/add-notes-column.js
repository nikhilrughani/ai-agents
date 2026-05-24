/**
 * One-time script to add a "Notes" rich_text property to your Notion database.
 * Run once: node add-notes-column.js
 */
require("dotenv").config();
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

(async () => {
  try {
    await notion.databases.update({
      database_id: process.env.NOTION_DATABASE_ID,
      properties: {
        Notes: { rich_text: {} },
      },
    });
    console.log("✅ Notes column added to your Notion database.");
    console.log("   You can now restart the dashboard and use the Notes field.");
  } catch (err) {
    if (err.message?.includes("already exists")) {
      console.log("ℹ️  Notes column already exists — nothing to do.");
    } else {
      console.error("❌ Error:", err.message);
    }
  }
})();
