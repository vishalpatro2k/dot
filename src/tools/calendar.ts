/**
 * Google Calendar Integration
 * 
 * Setup:
 * 1. Go to https://console.cloud.google.com
 * 2. Create a project and enable Calendar API
 * 3. Create OAuth credentials (Desktop app)
 * 4. Download credentials.json to project root
 * 5. Run: npm run cli -- --auth-calendar
 */

import { google, calendar_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const TOKEN_PATH = path.join(process.cwd(), "data", "calendar-token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
  location?: string;
  meetLink?: string;
  isAllDay: boolean;
}

export class CalendarTool {
  private auth: OAuth2Client | null = null;
  private calendar: calendar_v3.Calendar | null = null;

  async init(): Promise<boolean> {
    try {
      if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.log("⚠️  No credentials.json found. Calendar disabled.");
        return false;
      }

      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
      const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
      
      this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

      if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
        this.auth.setCredentials(token);
        this.calendar = google.calendar({ version: "v3", auth: this.auth });
        console.log("✓ Calendar connected");
        return true;
      }

      console.log("⚠️  Run with --auth-calendar to authenticate");
      return false;
    } catch (error) {
      console.error("Calendar init error:", error);
      return false;
    }
  }

  async authenticate(): Promise<void> {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error("❌ credentials.json not found");
      return;
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    
    this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const authUrl = this.auth.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });

    console.log("\n🔗 Authorize by visiting:\n");
    console.log(authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise<string>((resolve) => {
      rl.question("\nEnter the code: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });

    const { tokens } = await this.auth.getToken(code);
    this.auth.setCredentials(tokens);

    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    
    console.log("\n✓ Calendar authenticated!");
    this.calendar = google.calendar({ version: "v3", auth: this.auth });
  }

  async getTodaysEvents(): Promise<CalendarEvent[]> {
    if (!this.calendar) return [];

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    try {
      const response = await this.calendar.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      return (response.data.items || []).map((e) => ({
        id: e.id || "",
        title: e.summary || "Untitled",
        start: new Date(e.start?.dateTime || e.start?.date || ""),
        end: new Date(e.end?.dateTime || e.end?.date || ""),
        attendees: (e.attendees || []).filter((a) => !a.self).map((a) => a.displayName || a.email || ""),
        location: e.location || undefined,
        meetLink: e.hangoutLink || undefined,
        isAllDay: !e.start?.dateTime,
      }));
    } catch (error) {
      console.error("Calendar fetch error:", error);
      return [];
    }
  }

  async getContextString(): Promise<string> {
    const events = await this.getTodaysEvents();
    if (events.length === 0) return "No meetings today.";

    const now = new Date();
    return events.map((e) => {
      const time = e.isAllDay ? "All day" : 
        `${e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${e.end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      const status = e.start <= now && e.end >= now ? " 🔴 NOW" : e.end < now ? " ✓" : "";
      const attendees = e.attendees.length > 0 ? ` (${e.attendees.slice(0, 3).join(", ")}${e.attendees.length > 3 ? "..." : ""})` : "";
      return `• ${time}: ${e.title}${status}${attendees}`;
    }).join("\n");
  }
}

export const calendar = new CalendarTool();
