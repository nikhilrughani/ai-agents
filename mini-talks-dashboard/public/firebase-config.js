/**
 * Firebase client configuration
 * ─────────────────────────────
 * Fill in your Firebase project values here.
 *
 * How to find them:
 *   1. Go to console.firebase.google.com → your project
 *   2. Click the ⚙️ gear icon → Project settings
 *   3. Scroll to "Your apps" → click the </> Web app icon (create one if none)
 *   4. Copy the firebaseConfig object values below
 *
 * These values are NOT secret — they are safe to include in your source code.
 * Security is enforced by Firebase Authentication and Firestore rules,
 * not by keeping the config private.
 */
window.firebaseConfig = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  authDomain:        "REPLACE_WITH_YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket:     "REPLACE_WITH_YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "REPLACE_WITH_YOUR_SENDER_ID",
  appId:             "REPLACE_WITH_YOUR_APP_ID",
};
