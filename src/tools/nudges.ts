/**
 * Proactive Nudge Engine
 *
 * Monitors calendar and tasks, emits nudges for:
 * - Upcoming meetings (5-min warning)
 * - Back-to-back meeting streaks (break reminder)
 * - Overdue tasks
 * - End of day recap prompt
 */

import { EventEmitter } from "events";
import { calendar } from "./calendar.js";
import { notionTasks } from "./notion-tasks.js";
import { wellness } from "./wellness-analyzer.js";

export interface Nudge {
  id: string;
  type: "meeting_soon" | "meeting_now" | "break_needed" | "overdue_task" | "end_of_day";
  title: string;
  message: string;
  icon: string;
  priority: "high" | "medium" | "low";
  actionable?: {
    label: string;
    action: string;
  };
}

export class NudgeEngine extends EventEmitter {
  private checkInterval: NodeJS.Timeout | null = null;
  private sentNudges: Set<string> = new Set();
  private meetingsNotified: Set<string> = new Set();
  private lastBreakReminder: Date = new Date(0);

  start(): void {
    console.log("✓ Nudge engine started");
    this.checkInterval = setInterval(() => this.checkForNudges(), 60_000);
    this.checkForNudges();
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async checkForNudges(): Promise<void> {
    const now = new Date();
    const nudges: Nudge[] = [];

    nudges.push(...(await this.checkMeetings(now)));

    const breakNudge = await this.checkBreakNeeded(now);
    if (breakNudge) nudges.push(breakNudge);

    nudges.push(...(await this.checkOverdueTasks()));

    const eodNudge = this.checkEndOfDay(now);
    if (eodNudge) nudges.push(eodNudge);

    for (const nudge of nudges) {
      if (!this.sentNudges.has(nudge.id)) {
        this.sentNudges.add(nudge.id);
        this.emit("nudge", nudge);
      }
    }

    if (this.sentNudges.size > 200) {
      const arr = Array.from(this.sentNudges);
      this.sentNudges = new Set(arr.slice(-100));
    }
  }

  private async checkMeetings(now: Date): Promise<Nudge[]> {
    const nudges: Nudge[] = [];
    try {
      const events = await calendar.getUpcomingEvents(2);
      for (const event of events) {
        const minutesUntil = Math.floor(
          (event.start.getTime() - now.getTime()) / 60_000
        );

        if (minutesUntil > 0 && minutesUntil <= 5 && !this.meetingsNotified.has(`${event.id}-5min`)) {
          this.meetingsNotified.add(`${event.id}-5min`);
          const withWhom =
            event.attendees.length > 0
              ? ` with ${event.attendees.slice(0, 2).join(", ")}`
              : "";
          nudges.push({
            id: `meeting-${event.id}-5min`,
            type: "meeting_soon",
            title: "Meeting in 5 minutes",
            message: `${event.title}${withWhom}`,
            icon: "📅",
            priority: "high",
            actionable: event.meetLink ? { label: "Join", action: event.meetLink } : undefined,
          });
        }

        if (minutesUntil <= 0 && minutesUntil > -2 && !this.meetingsNotified.has(`${event.id}-now`)) {
          this.meetingsNotified.add(`${event.id}-now`);
          nudges.push({
            id: `meeting-${event.id}-now`,
            type: "meeting_now",
            title: "Meeting starting",
            message: event.title,
            icon: "🔴",
            priority: "high",
            actionable: event.meetLink ? { label: "Join now", action: event.meetLink } : undefined,
          });
        }
      }
    } catch {
      // Calendar unavailable — skip
    }
    return nudges;
  }

  private async checkBreakNeeded(now: Date): Promise<Nudge | null> {
    const hour = now.getHours();
    if (hour < 9 || hour > 18) return null;

    const minutesSinceLast =
      (now.getTime() - this.lastBreakReminder.getTime()) / 60_000;
    if (minutesSinceLast < 90) return null;

    try {
      const { stats } = await wellness.analyzeTodayCalendar();
      if (stats.backToBackCount >= 2) {
        this.lastBreakReminder = now;
        return {
          id: `break-${now.toISOString().split("T")[0]}-${now.getHours()}`,
          type: "break_needed",
          title: "Break reminder",
          message: `${stats.backToBackCount} back-to-back meetings. Quick stretch?`,
          icon: "☕",
          priority: "low",
        };
      }
    } catch {
      // Wellness unavailable
    }
    return null;
  }

  private async checkOverdueTasks(): Promise<Nudge[]> {
    if (!notionTasks.isConfigured()) return [];
    try {
      const overdue = await notionTasks.getOverdueTasks();
      return overdue.slice(0, 2).map((task) => ({
        id: `overdue-${task.id}`,
        type: "overdue_task" as const,
        title: "Overdue task",
        message: `"${task.title}" was due ${task.dueDate}`,
        icon: "⚠️",
        priority: "medium" as const,
      }));
    } catch {
      return [];
    }
  }

  private checkEndOfDay(now: Date): Nudge | null {
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (hour === 18 && minute < 5) {
      const id = `eod-${now.toISOString().split("T")[0]}`;
      if (!this.sentNudges.has(id)) {
        return {
          id,
          type: "end_of_day",
          title: "Wrapping up?",
          message: "Good time for a quick day recap. How did today go?",
          icon: "🌅",
          priority: "low",
          actionable: { label: "Day recap", action: "recap" },
        };
      }
    }
    return null;
  }

  async getPendingNudges(): Promise<Nudge[]> {
    const now = new Date();
    const nudges: Nudge[] = [
      ...(await this.checkMeetings(now)),
      ...(await this.checkOverdueTasks()),
    ];
    return nudges;
  }
}

export const nudgeEngine = new NudgeEngine();
