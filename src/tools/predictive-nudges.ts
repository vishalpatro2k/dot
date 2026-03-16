/**
 * Predictive Nudges
 *
 * Surfaces proactive insights: tomorrow preview, burnout risk,
 * deadline alerts, pattern detection, and energy prediction.
 */

import { calendar } from "./calendar.js";
import { healthData } from "./health-data.js";
import { wellness } from "./wellness-analyzer.js";
import { memory } from "../memory/store.js";

export type NudgeType =
  | "tomorrow_preview"
  | "burnout_risk"
  | "deadline_alert"
  | "pattern_insight"
  | "energy_prediction";

export interface Nudge {
  type: NudgeType;
  priority: "high" | "medium" | "low";
  message: string;
  actionable?: string;
}

export class PredictiveNudgeEngine {
  async getNudges(): Promise<Nudge[]> {
    const nudges: Nudge[] = [];

    try {
      const [tomorrow, burnout, pattern] = await Promise.all([
        this.tomorrowPreview(),
        this.burnoutRisk(),
        this.patternInsight(),
      ]);

      if (tomorrow) nudges.push(tomorrow);
      if (burnout) nudges.push(burnout);
      if (pattern) nudges.push(pattern);

      const energy = this.energyPrediction();
      if (energy) nudges.push(energy);
    } catch {
      // Best-effort
    }

    return nudges.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
  }

  private async tomorrowPreview(): Promise<Nudge | null> {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const events = await calendar.getEventsForDate(tomorrow);
      if (!events.length) return null;

      const meetingHours = events.reduce((s, e) => s + e.duration / 60, 0);
      const firstEvent = events[0];
      const timeStr = firstEvent.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      let msg = `Tomorrow: ${events.length} meeting${events.length > 1 ? "s" : ""} (${meetingHours.toFixed(1)}h), first at ${timeStr}`;
      let priority: Nudge["priority"] = "low";
      let actionable: string | undefined;

      if (meetingHours > 5) {
        priority = "high";
        msg += " — heavy day ahead";
        actionable = "Block prep time tonight or reschedule a non-critical meeting";
      } else if (meetingHours > 3) {
        priority = "medium";
      }

      return { type: "tomorrow_preview", priority, message: msg, actionable };
    } catch {
      return null;
    }
  }

  private async burnoutRisk(): Promise<Nudge | null> {
    try {
      const history = wellness.getDayHistory(5);
      if (history.length < 3) return null;

      const avgMeetingHours = history.reduce((s, d) => s + d.meetingHours, 0) / history.length;
      const heavyDays = history.filter((d) => d.meetingHours > 4).length;
      const noLunchDays = history.filter((d) => !d.lunchProtected).length;

      const today = new Date().toISOString().split("T")[0];
      const health = healthData.getHealthData(today);
      const sleep = health?.sleep?.totalHours ?? 7;

      let riskScore = 0;
      if (avgMeetingHours > 4) riskScore += 2;
      if (heavyDays >= 3) riskScore += 2;
      if (noLunchDays >= 3) riskScore += 1;
      if (sleep < 6) riskScore += 2;
      if (health?.vitals?.hrv && health.vitals.hrv < 30) riskScore += 1;

      if (riskScore >= 4) {
        return {
          type: "burnout_risk",
          priority: "high",
          message: `Burnout signal: ${heavyDays}/5 heavy days, avg ${avgMeetingHours.toFixed(1)}h/day meetings${sleep < 6 ? `, ${sleep}h sleep` : ""}`,
          actionable: "Protect at least one no-meeting morning this week",
        };
      }

      if (riskScore >= 2 && heavyDays >= 2) {
        return {
          type: "burnout_risk",
          priority: "medium",
          message: `Pace check: ${heavyDays} heavy meeting days this week`,
          actionable: "Grab a proper break today",
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private patternInsight(): Nudge | null {
    try {
      const patterns = wellness.getPatterns();
      const dow = new Date().toLocaleDateString("en-US", { weekday: "long" });

      if (patterns.busiestDayOfWeek === dow) {
        return {
          type: "pattern_insight",
          priority: "medium",
          message: `${dow} tends to be your busiest day — heads up`,
          actionable: "Keep discretionary tasks for tomorrow",
        };
      }

      if (patterns.lunchProtectedPercent < 40) {
        return {
          type: "pattern_insight",
          priority: "medium",
          message: `Lunch is blocked ${Math.round(100 - patterns.lunchProtectedPercent)}% of days`,
          actionable: "Block 12-1pm as a recurring hold",
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private energyPrediction(): Nudge | null {
    try {
      const today = new Date().toISOString().split("T")[0];
      const health = healthData.getHealthData(today);
      if (!health) return null;

      const sleep = health.sleep.totalHours;
      const hrv = health.vitals?.hrv;
      const hour = new Date().getHours();

      // Only surface during work hours
      if (hour < 9 || hour > 18) return null;

      if (sleep < 5.5 && hrv && hrv < 30) {
        return {
          type: "energy_prediction",
          priority: "high",
          message: `Low energy likely all day: ${sleep.toFixed(1)}h sleep + HRV ${hrv}`,
          actionable: "Reschedule anything cognitively demanding if you can",
        };
      }

      if (sleep >= 7.5 && hrv && hrv > 60) {
        return {
          type: "energy_prediction",
          priority: "low",
          message: `High energy day: ${sleep.toFixed(1)}h sleep + strong HRV (${hrv})`,
          actionable: "Good day for deep work or a hard conversation",
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  async getContextString(): Promise<string> {
    const nudges = await this.getNudges();
    if (nudges.length === 0) return "";

    const top = nudges.slice(0, 3);
    const lines = top.map((n) => {
      const prefix = n.priority === "high" ? "⚠️" : n.priority === "medium" ? "💡" : "ℹ️";
      return `${prefix} ${n.message}${n.actionable ? `\n   → ${n.actionable}` : ""}`;
    });

    return `PREDICTIVE NUDGES\n${lines.join("\n")}`;
  }
}

export const predictiveNudges = new PredictiveNudgeEngine();
