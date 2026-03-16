/**
 * Wellness Analyzer
 *
 * Analyzes calendar load, break patterns, and energy indicators.
 * Produces insights to surface in morning briefs and day recaps.
 */

import { calendar, CalendarEvent } from "./calendar.js";
import { memory } from "../memory/store.js";

export interface DayStats {
  date: string;
  meetingCount: number;
  meetingHours: number;
  longestMeeting: number; // minutes
  backToBackCount: number;
  focusBlocks: number;
  focusHours: number;
  breakCount: number;
  firstMeeting: string | null;
  lastMeeting: string | null;
  lunchProtected: boolean;
}

export interface WellnessInsight {
  type: "warning" | "positive" | "neutral";
  icon: string;
  title: string;
  message: string;
}

export class WellnessAnalyzer {
  async analyzeTodayCalendar(): Promise<{ stats: DayStats; insights: WellnessInsight[]; events: CalendarEvent[] }> {
    const events = await calendar.getTodaysEvents();
    const stats = this.calculateDayStats(events, new Date());
    const insights = this.generateInsights(stats);
    return { stats, insights, events };
  }

  async analyzeYesterday(): Promise<{ stats: DayStats; insights: WellnessInsight[]; events: CalendarEvent[] }> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const events = await calendar.getEventsForDate(yesterday);
    const stats = this.calculateDayStats(events, yesterday);
    const insights = this.generateRecapInsights(stats);
    return { stats, insights, events };
  }

  async getWeekComparison(): Promise<{
    thisWeek: { meetings: number; hours: number };
    lastWeek: { meetings: number; hours: number };
    change: number;
    busiestDay: string;
  }> {
    const [thisWeek, lastWeek] = await Promise.all([
      calendar.getWeekStats(),
      calendar.getLastWeekStats(),
    ]);

    const change =
      lastWeek.totalHours > 0
        ? Math.round(((thisWeek.totalHours - lastWeek.totalHours) / lastWeek.totalHours) * 100)
        : 0;

    return {
      thisWeek: { meetings: thisWeek.totalMeetings, hours: thisWeek.totalHours },
      lastWeek: { meetings: lastWeek.totalMeetings, hours: lastWeek.totalHours },
      change,
      busiestDay: thisWeek.busiestDay,
    };
  }

  calculateDayStats(events: CalendarEvent[], date: Date): DayStats {
    const meetings = events.filter((e) => !e.isAllDay);
    const sorted = [...meetings].sort((a, b) => a.start.getTime() - b.start.getTime());

    const totalMinutes = meetings.reduce((sum, e) => sum + e.duration, 0);
    const longestMeeting = meetings.length > 0 ? Math.max(...meetings.map((e) => e.duration)) : 0;

    let backToBackCount = 0;
    let focusBlocks = 0;
    let focusMinutes = 0;
    let breakCount = 0;

    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].start.getTime() - sorted[i - 1].end.getTime()) / 60_000;
      if (gap < 15) backToBackCount++;
      else if (gap < 60) breakCount++;
      else { focusBlocks++; focusMinutes += gap; }
    }

    const lunchStart = new Date(date); lunchStart.setHours(12, 0, 0, 0);
    const lunchEnd = new Date(date); lunchEnd.setHours(13, 0, 0, 0);
    const lunchBlocked = meetings.some(
      (e) => e.start < lunchEnd && e.end > lunchStart
    );

    const fmt = (d: Date) =>
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    return {
      date: date.toISOString().split("T")[0],
      meetingCount: meetings.length,
      meetingHours: Math.round((totalMinutes / 60) * 10) / 10,
      longestMeeting,
      backToBackCount,
      focusBlocks,
      focusHours: Math.round((focusMinutes / 60) * 10) / 10,
      breakCount,
      firstMeeting: sorted[0] ? fmt(sorted[0].start) : null,
      lastMeeting: sorted[sorted.length - 1] ? fmt(sorted[sorted.length - 1].end) : null,
      lunchProtected: !lunchBlocked,
    };
  }

  generateInsights(stats: DayStats): WellnessInsight[] {
    const insights: WellnessInsight[] = [];

    if (stats.meetingHours >= 6) {
      insights.push({ type: "warning", icon: "🔥", title: "Heavy day", message: `${stats.meetingHours}h of meetings. Consider declining optional ones.` });
    }
    if (stats.backToBackCount >= 3) {
      insights.push({ type: "warning", icon: "⚠️", title: "Back-to-back alert", message: `${stats.backToBackCount} meetings with no buffer. Stay hydrated!` });
    }
    if (!stats.lunchProtected) {
      insights.push({ type: "warning", icon: "🍽️", title: "Lunch blocked", message: "Meeting during lunch — grab food before?" });
    }
    if (stats.focusBlocks > 0) {
      insights.push({ type: "positive", icon: "🎯", title: "Focus time", message: `${stats.focusHours}h uninterrupted across ${stats.focusBlocks} block${stats.focusBlocks > 1 ? "s" : ""}.` });
    }
    if (stats.meetingCount >= 4 && stats.breakCount === 0 && stats.backToBackCount < 3) {
      insights.push({ type: "warning", icon: "☕", title: "No breaks", message: "Dense schedule with no buffer. Block 15 min somewhere?" });
    }
    if (stats.longestMeeting >= 90) {
      insights.push({ type: "neutral", icon: "⏱️", title: "Long meeting", message: `Longest block is ${Math.round(stats.longestMeeting / 60 * 10) / 10}h. Pace yourself.` });
    }
    if (stats.meetingHours <= 2 && stats.meetingCount <= 3) {
      insights.push({ type: "positive", icon: "🌿", title: "Light day", message: "Room to breathe. Good day for deep work." });
    }

    return insights;
  }

  generateRecapInsights(stats: DayStats): WellnessInsight[] {
    const insights: WellnessInsight[] = [];

    if (stats.meetingHours >= 7) {
      insights.push({ type: "warning", icon: "😮‍💨", title: "Exhausting day", message: `${stats.meetingHours}h in meetings. Hope you got some rest.` });
    } else if (stats.meetingHours <= 3 && stats.meetingHours > 0) {
      insights.push({ type: "positive", icon: "✨", title: "Balanced day", message: `Only ${stats.meetingHours}h of meetings.` });
    }

    if (stats.lastMeeting) {
      const raw = stats.lastMeeting;
      const isPM = raw.includes("PM");
      const hour = parseInt(raw.split(":")[0]);
      const hour24 = isPM && hour !== 12 ? hour + 12 : hour;
      if (hour24 >= 19) {
        insights.push({ type: "warning", icon: "🌙", title: "Late finish", message: `Last meeting ended at ${stats.lastMeeting}. Try to wrap up earlier tomorrow.` });
      }
    }

    return insights;
  }

  saveDay(stats: DayStats): void {
    memory.saveKV(`day:${stats.date}`, stats);
  }

  getDayHistory(days = 7): DayStats[] {
    const history: DayStats[] = [];
    const today = new Date();
    for (let i = 1; i <= days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const saved = memory.getKV<DayStats>(`day:${d.toISOString().split("T")[0]}`);
      if (saved) history.push(saved);
    }
    return history;
  }

  getPatterns(): {
    avgMeetingHours: number;
    avgMeetings: number;
    busiestDayOfWeek: string;
    lightestDayOfWeek: string;
    avgBackToBacks: number;
    lunchProtectedPercent: number;
  } {
    const history = this.getDayHistory(14);

    if (history.length === 0) {
      return { avgMeetingHours: 0, avgMeetings: 0, busiestDayOfWeek: "", lightestDayOfWeek: "", avgBackToBacks: 0, lunchProtectedPercent: 0 };
    }

    const dayOfWeekHours: Record<string, number[]> = {};
    let totalHours = 0, totalMeetings = 0, totalBackToBacks = 0, lunchProtectedDays = 0;

    for (const day of history) {
      const dayName = new Date(day.date).toLocaleDateString("en-US", { weekday: "long" });
      if (!dayOfWeekHours[dayName]) dayOfWeekHours[dayName] = [];
      dayOfWeekHours[dayName].push(day.meetingHours);
      totalHours += day.meetingHours;
      totalMeetings += day.meetingCount;
      totalBackToBacks += day.backToBackCount;
      if (day.lunchProtected) lunchProtectedDays++;
    }

    const avgByDay = Object.entries(dayOfWeekHours)
      .map(([day, hrs]) => ({ day, avg: hrs.reduce((a, b) => a + b, 0) / hrs.length }))
      .sort((a, b) => b.avg - a.avg);

    return {
      avgMeetingHours: Math.round((totalHours / history.length) * 10) / 10,
      avgMeetings: Math.round((totalMeetings / history.length) * 10) / 10,
      busiestDayOfWeek: avgByDay[0]?.day || "",
      lightestDayOfWeek: avgByDay[avgByDay.length - 1]?.day || "",
      avgBackToBacks: Math.round((totalBackToBacks / history.length) * 10) / 10,
      lunchProtectedPercent: Math.round((lunchProtectedDays / history.length) * 100),
    };
  }
}

export const wellness = new WellnessAnalyzer();
