/**
 * Shared Google OAuth2 helper
 *
 * Handles auth for both Calendar and Gmail using a local HTTP callback server
 * on port 3333. Tokens are stored separately per scope set.
 *
 * Setup:
 * 1. Go to https://console.cloud.google.com
 * 2. Create a project, enable Calendar API + Gmail API
 * 3. Create OAuth credentials (Desktop app) with redirect URI:
 *    http://localhost:3333/oauth2callback
 * 4. Download credentials.json to project root
 * 5. Run: npm run cli -- --auth-google
 */

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as url from "url";
// @ts-ignore — 'open' has no bundled types but works fine at runtime
import open from "open";

const CREDENTIALS_PATH = path.join(process.cwd(), "google-credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "data", "google-token.json");
const CALLBACK_PORT = 3333;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth2callback`;

// Combined scopes for Calendar (read) + Gmail (read)
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

function loadCredentials(): { client_id: string; client_secret: string } {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `google-credentials.json not found at project root.\n` +
      `Download it from https://console.cloud.google.com (OAuth 2.0 Desktop app).`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  return raw.installed || raw.web;
}

function loadToken(): Record<string, any> | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveToken(token: Record<string, any>): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

/**
 * Build an authorized OAuth2Client.
 * - Loads saved token if available and refreshes if expired.
 * - Returns null if no credentials file or no token yet.
 */
export async function getAuthClient(): Promise<OAuth2Client | null> {
  let creds: { client_id: string; client_secret: string };
  try {
    creds = loadCredentials();
  } catch {
    return null;
  }

  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const token = loadToken();
  if (!token) return null;

  auth.setCredentials(token);

  // Auto-refresh expired token
  auth.on("tokens", (newTokens) => {
    const merged = { ...token, ...newTokens };
    saveToken(merged);
  });

  // Force a refresh if access token is close to expiry (within 5 minutes)
  if (token.expiry_date && Date.now() > token.expiry_date - 5 * 60 * 1000) {
    try {
      const { credentials } = await auth.refreshAccessToken();
      saveToken({ ...token, ...credentials });
      auth.setCredentials({ ...token, ...credentials });
    } catch (err) {
      console.warn("⚠️  Google token refresh failed:", (err as Error).message);
    }
  }

  return auth;
}

/**
 * Run the full OAuth2 flow using a local HTTP server for the callback.
 * Opens the browser automatically, waits for the redirect, saves the token.
 */
export async function runAuthFlow(): Promise<void> {
  let creds: { client_id: string; client_secret: string };
  try {
    creds = loadCredentials();
  } catch (err: any) {
    console.error("\n❌", err.message);
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force refresh_token to be returned
  });

  console.log("\n🔐 Opening browser for Google authorization…\n");
  console.log("If the browser doesn't open, visit:\n");
  console.log(authUrl, "\n");

  await open(authUrl);

  // Wait for the OAuth callback on localhost:3333
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url || "", true);
      if (parsed.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const authCode = parsed.query.code as string | undefined;
      if (!authCode) {
        res.writeHead(400);
        res.end("Missing code");
        reject(new Error("No code in OAuth callback"));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✓ Authorized!</h2>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);
      server.close();
      resolve(authCode);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`Waiting for callback on http://localhost:${CALLBACK_PORT}…\n`);
    });

    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout — no callback received within 5 minutes"));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await auth.getToken(code);
  saveToken(tokens);

  console.log("✓ Google authentication complete!");
  console.log(`  Token saved to ${TOKEN_PATH}`);
  console.log("  Scopes: Calendar (read) + Gmail (read)\n");
}
