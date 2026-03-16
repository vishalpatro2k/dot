/**
 * Google Calendar Integration
 *
 * Uses the shared google-auth.ts OAuth2 client.
 * Run `npm run cli -- --auth-google` to authenticate.
 */

import { google, calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getAuthClient } from "./google-auth.js";

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  duration: number; // minutes
  attendees: string[];
  location?: string;
  meetLink?: string;
  isAllDay: boolean;
}

function parseEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const start = new Date(e.start?.dateTime || e.start?.date || "");
  const end = new Date(e.end?.dateTime || e.end?.date || "");
  const duration = Math.round((end.getTime() - start.getTime()) / 60_000);
  return {
    id: e.id || "",
    title: e.summary || "Untitled",
    start,
    end,
    duration,
    attendees: (e.attendees || []).filter((a) => !a.self).map((a) => a.displayName || a.email || ""),
    location: e.location || undefined,
    meetLink: e.hangoutLink || undefined,
    isAllDay: !e.start?.dateTime,
  };
}

export class CalendarTool {
  private cal: calendar_v3.Calendar | null = null;

  async init(): Promise<boolean> {
    try {
      const auth = await getAuthClient();
      if (!auth) {
        console.log("⚠️  Calendar not authenticated. Run --auth-google.");
        return false;
      }
      this.cal = google.calendar({ version: "v3", auth: auth as OAuth2Client });
      console.log("✓ Calendar connected");
      return true;
    } catch (err) {
      console.error("Calendar init error:", err);
      return false;
    }
  }

  /** Legacy entry point — kept for CLI backwards-compat */
  async authenticate(): Promise<void> {
    const { runAuthFlow } = await import("./google-auth.js");
    await runAuthFlow();
  }

  private async getEventsInRange(start: Date, end: Date): Promise<CalendarEvent[]> {
    if (!this.cal) return [];
    try {
      const response = await this.cal.events.list({
        calendarId: "primary",
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      return (response.data.items || []).map(parseEvent);
    } catch (err) {
      console.error("Calendar fetch error:", err);
      return [];
    }
  }

  async getTodaysEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    return this.getEventsInRange(startOfDay, endOfDay);
  }

  async getEventsForDate(date: Date): Promise<CalendarEvent[]> {
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);
    return this.getEventsInRange(start, end);
  }

  async getWeekStats(): Promise<{
    total: number;
    totalMeetings: number;
    focusBlocks: number;
    meetingHours: number;
    totalHours: number;
    busiestDay: string;
    avgPerDay: number;
  }> {
    if (!this.cal) return { total: 0, totalMeetings: 0, focusBlocks: 0, meetingHours: 0, totalHours: 0, busiestDay: "", avgPerDay: 0 };

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    const events = await this.getEventsInRange(startOfWeek, endOfWeek);
    const meetings = events.filter((e) => !e.isAllDay);
    const dayCount: Record<string, number> = {};
    let totalMinutes = 0;
    let focusBlocks = 0;

    for (const e of meetings) {
      const day = e.start.toLocaleDateString("en-US", { weekday: "long" });
      dayCount[day] = (dayCount[day] || 0) + 1;
      totalMinutes += e.duration;
      if (/focus|deep work|block|no meeting/i.test(e.title)) focusBlocks++;
    }

    const busiestDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const totalHours = Math.round((totalMinutes / 60) * 10) / 10;

    return {
      total: meetings.length,
      totalMeetings: meetings.length,
      focusBlocks,
      meetingHours: totalHours,
      totalHours,
      busiestDay,
      avgPerDay: Math.round((meetings.length / 7) * 10) / 10,
    };
  }

  async getLastWeekStats(): Promise<{
    totalMeetings: number;
    totalHours: number;
    busiestDay: string;
    avgPerDay: number;
  }> {
    if (!this.cal) return { totalMeetings: 0, totalHours: 0, busiestDay: "", avgPerDay: 0 };

    const now = new Date();
    const endOfLastWeek = new Date(now);
    endOfLastWeek.setDate(now.getDate() - now.getDay());
    endOfLastWeek.setHours(0, 0, 0, 0);
    const startOfLastWeek = new Date(endOfLastWeek);
    startOfLastWeek.setDate(endOfLastWeek.getDate() - 7);

    const events = await this.getEventsInRange(startOfLastWeek, endOfLastWeek);
    const meetings = events.filter((e) => !e.isAllDay);
    const dayCount: Record<string, number> = {};
    let totalMinutes = 0;

    for (const e of meetings) {
      const day = e.start.toLocaleDateString("en-US", { weekday: "long" });
      dayCount[day] = (dayCount[day] || 0) + 1;
      totalMinutes += e.duration;
    }

    const busiestDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

    return {
      totalMeetings: meetings.length,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      busiestDay,
      avgPerDay: Math.round((meetings.length / 7) * 10) / 10,
    };
  }

  async getUpcomingEvents(hoursAhead = 2): Promise<CalendarEvent[]> {
    const now = new Date();
    const end = new Date(now.getTime() + hoursAhead * 60 * 60_000);
    return this.getEventsInRange(now, end);
  }

  async getContextString(): Promise<string> {
    const events = await this.getTodaysEvents();
    if (events.length === 0) return "No meetings today.";

    const now = new Date();
    return events.map((e) => {
      const time = e.isAllDay
        ? "All day"
        : `${e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${e.end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      const status = e.start <= now && e.end >= now ? " 🔴 NOW" : e.end < now ? " ✓" : "";
      const attendees =
        e.attendees.length > 0
          ? ` (${e.attendees.slice(0, 3).join(", ")}${e.attendees.length > 3 ? "…" : ""})`
          : "";
      const durationTag = !e.isAllDay && e.duration > 45 ? ` [${e.duration}m]` : "";
      return `• ${time}: ${e.title}${durationTag}${status}${attendees}`;
    }).join("\n");
  }
}

export const calendar = new CalendarTool();
