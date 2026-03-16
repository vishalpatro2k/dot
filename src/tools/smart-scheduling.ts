/**
 * Smart Scheduler
 *
 * Finds optimal meeting slots based on calendar load, wellness patterns,
 * and configurable preferences (lunch protection, back-to-back avoidance).
 */

import { calendar, CalendarEvent } from "./calendar.js";
import { wellness } from "./wellness-analyzer.js";

export interface TimeSlot {
  start: Date;
  end: Date;
  duration: number; // minutes
  quality: "ideal" | "good" | "okay" | "avoid";
  reason: string;
}

export interface SchedulingSuggestion {
  slots: TimeSlot[];
  recommendation: TimeSlot | null;
  reasoning: string;
  warnings: string[];
}

interface SchedulingPreferences {
  workStartHour: number;
  workEndHour: number;
  protectLunch: boolean;
  avoidBackToBack: boolean;
  minBreakBetween: number; // minutes
}

const DEFAULT_PREFS: SchedulingPreferences = {
  workStartHour: 9,
  workEndHour: 18,
  protectLunch: true,
  avoidBackToBack: true,
  minBreakBetween: 15,
};

export class SmartScheduler {
  private prefs: SchedulingPreferences = DEFAULT_PREFS;

  setPreferences(p: Partial<SchedulingPreferences>): void {
    this.prefs = { ...this.prefs, ...p };
  }

  async findFreeSlots(
    durationMinutes: number,
    withinDays = 5,
    options?: { preferDate?: Date }
  ): Promise<SchedulingSuggestion> {
    const slots: TimeSlot[] = [];
    const now = new Date();

    for (let offset = 0; offset < withinDays; offset++) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      if (date.getDay() === 0 || date.getDay() === 6) continue; // skip weekends
      const daySlots = await this.slotsForDay(date, durationMinutes);
      slots.push(...daySlots);
    }

    // Sort: ideal first, then by date
    const order = { ideal: 0, good: 1, okay: 2, avoid: 3 };
    slots.sort((a, b) => {
      const qd = order[a.quality] - order[b.quality];
      return qd !== 0 ? qd : a.start.getTime() - b.start.getTime();
    });

    let recommendation = slots.find((s) => s.quality === "ideal") ?? slots.find((s) => s.quality === "good") ?? slots[0] ?? null;

    if (options?.preferDate) {
      const preferred = slots.filter((s) => this.sameDay(s.start, options.preferDate!));
      if (preferred.length > 0) {
        recommendation = preferred.find((s) => s.quality === "ideal") ?? preferred.find((s) => s.quality === "good") ?? preferred[0];
      }
    }

    // Warnings from wellness
    const warnings: string[] = [];
    try {
      const weekStats = await wellness.getWeekComparison();
      if (weekStats.thisWeek.hours > 25) {
        warnings.push("Already heavy on meetings this week. Consider declining something first.");
      }
      const patterns = wellness.getPatterns();
      if (recommendation && patterns.busiestDayOfWeek) {
        const recDay = recommendation.start.toLocaleDateString("en-US", { weekday: "long" });
        if (recDay === patterns.busiestDayOfWeek) {
          warnings.push(`${recDay} is usually your busiest day.`);
        }
      }
    } catch {
      // Wellness data optional
    }

    let reasoning: string;
    if (!recommendation) {
      reasoning = `No ${durationMinutes}-minute slots found in the next ${withinDays} working days.`;
    } else if (recommendation.quality === "ideal") {
      reasoning = `${this.fmtSlot(recommendation)} looks ideal — ${recommendation.reason}`;
    } else if (recommendation.quality === "good") {
      reasoning = `${this.fmtSlot(recommendation)} works well — ${recommendation.reason}`;
    } else {
      reasoning = `Best available is ${this.fmtSlot(recommendation)} — ${recommendation.reason}`;
    }

    return { slots: slots.slice(0, 10), recommendation, reasoning, warnings };
  }

  async suggestFocusBlock(durationMinutes = 120): Promise<SchedulingSuggestion> {
    const suggestion = await this.findFreeSlots(durationMinutes, 3);

    // Prefer morning (9–12) or early afternoon (14–17) for focus
    const focusSlots = suggestion.slots.filter((s) => {
      const h = s.start.getHours();
      return (h >= 9 && h < 12) || (h >= 14 && h < 17);
    });

    if (focusSlots.length > 0) {
      suggestion.recommendation = focusSlots[0];
      suggestion.reasoning = `${this.fmtSlot(focusSlots[0])} is a solid focus block — ${focusSlots[0].reason}`;
    }

    return suggestion;
  }

  async checkConflicts(proposedStart: Date, durationMinutes: number): Promise<{
    hasConflict: boolean;
    conflicts: CalendarEvent[];
    suggestion?: TimeSlot;
  }> {
    const proposedEnd = new Date(proposedStart.getTime() + durationMinutes * 60_000);
    const events = await calendar.getEventsForDate(proposedStart);
    const conflicts = events.filter(
      (e) => !e.isAllDay && e.start < proposedEnd && e.end > proposedStart
    );

    if (conflicts.length === 0) return { hasConflict: false, conflicts: [] };

    const alternatives = await this.findFreeSlots(durationMinutes, 1, { preferDate: proposedStart });
    return { hasConflict: true, conflicts, suggestion: alternatives.recommendation ?? undefined };
  }

  private async slotsForDay(date: Date, durationMinutes: number): Promise<TimeSlot[]> {
    const events = await calendar.getEventsForDate(date);
    const slots: TimeSlot[] = [];

    const dayStart = new Date(date);
    dayStart.setHours(this.prefs.workStartHour, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(this.prefs.workEndHour, 0, 0, 0);

    const busy = events
      .filter((e) => !e.isAllDay)
      .map((e) => ({ start: e.start, end: e.end }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    let cursor = dayStart;

    for (const period of busy) {
      const gapMinutes = (period.start.getTime() - cursor.getTime()) / 60_000;
      if (gapMinutes >= durationMinutes) {
        const slot = this.evaluateSlot(cursor, durationMinutes, busy);
        if (slot) slots.push(slot);
      }
      cursor = new Date(period.end.getTime() + this.prefs.minBreakBetween * 60_000);
    }

    // Gap after last meeting
    if ((dayEnd.getTime() - cursor.getTime()) / 60_000 >= durationMinutes) {
      const slot = this.evaluateSlot(cursor, durationMinutes, busy);
      if (slot) slots.push(slot);
    }

    return slots;
  }

  private evaluateSlot(
    start: Date,
    duration: number,
    busy: { start: Date; end: Date }[]
  ): TimeSlot {
    const end = new Date(start.getTime() + duration * 60_000);
    const hour = start.getHours();

    let quality: TimeSlot["quality"] = "good";
    let reason = "";

    if (this.prefs.protectLunch && hour >= 12 && hour < 13) {
      quality = "avoid";
      reason = "during lunch hour";
    } else if (
      this.prefs.avoidBackToBack &&
      busy.some((b) => {
        const before = (start.getTime() - b.end.getTime()) / 60_000;
        const after = (b.start.getTime() - end.getTime()) / 60_000;
        return (before >= 0 && before < this.prefs.minBreakBetween) ||
               (after >= 0 && after < this.prefs.minBreakBetween);
      })
    ) {
      quality = "okay";
      reason = "back-to-back with another meeting";
    } else {
      const hasBuffer = busy.every((b) => {
        const before = Math.abs(start.getTime() - b.end.getTime()) / 60_000;
        const after = Math.abs(b.start.getTime() - end.getTime()) / 60_000;
        return before >= 30 || after >= 30;
      });

      if (hasBuffer && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 17))) {
        quality = "ideal";
        reason = hour < 12 ? "morning slot with good buffer" : "afternoon slot with good buffer";
      } else if (hasBuffer) {
        quality = "good";
        reason = "good buffer around it";
      } else {
        quality = "good";
        reason = "available slot";
      }
    }

    return { start, end, duration, quality, reason };
  }

  formatSuggestion(s: SchedulingSuggestion): string {
    const lines: string[] = [s.reasoning];

    if (s.warnings.length > 0) {
      lines.push("");
      s.warnings.forEach((w) => lines.push(`⚠️ ${w}`));
    }

    const others = s.slots.filter((sl) => sl !== s.recommendation).slice(0, 3);
    if (others.length > 0) {
      lines.push("\nOther options:");
      others.forEach((sl) => {
        const icon = sl.quality === "ideal" ? "★" : sl.quality === "good" ? "●" : "○";
        lines.push(`${icon} ${this.fmtSlot(sl)}`);
      });
    }

    return lines.join("\n");
  }

  private fmtSlot(slot: TimeSlot): string {
    const isToday = this.sameDay(slot.start, new Date());
    const day = isToday
      ? "Today"
      : slot.start.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const time = slot.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${day} at ${time}`;
  }

  private sameDay(a: Date, b: Date): boolean {
    return a.toDateString() === b.toDateString();
  }
}

export const smartScheduler = new SmartScheduler();
