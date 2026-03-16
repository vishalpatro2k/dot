/**
 * Personality Engine
 *
 * Adapts Dot's tone based on time of day, sleep quality, calendar load,
 * and day of week. Returns a context string injected into the system prompt.
 */

import { healthData } from "./health-data.js";
import { focusMode } from "./focus-mode.js";

export type ToneMode = "energetic" | "calm" | "supportive" | "direct" | "gentle";

export interface PersonalityContext {
  tone: ToneMode;
  energyLevel: "low" | "medium" | "high";
  greeting: string;
  contextHints: string[];
}

export class PersonalityEngine {
  getTone(meetingHours = 0): PersonalityContext {
    const hour = new Date().getHours();
    const today = new Date().toISOString().split("T")[0];
    const health = healthData.getHealthData(today);
    const sleepHours = health?.sleep?.totalHours ?? 7;
    const hrv = health?.vitals?.hrv ?? 50;
    const focusMinutes = focusMode.getTodaysFocusMinutes();

    // Determine energy level
    let energyLevel: "low" | "medium" | "high" = "medium";
    if (sleepHours < 5.5 || hrv < 30) {
      energyLevel = "low";
    } else if (sleepHours >= 7.5 && hrv >= 55) {
      energyLevel = "high";
    }

    // Determine tone
    let tone: ToneMode;
    const hints: string[] = [];

    if (energyLevel === "low") {
      tone = "gentle";
      hints.push(`Only ${sleepHours.toFixed(1)}h sleep — keep responses short and kind`);
    } else if (hour >= 6 && hour < 10) {
      tone = energyLevel === "high" ? "energetic" : "calm";
      hints.push("Morning — set a positive tone for the day");
    } else if (hour >= 10 && hour < 14) {
      tone = meetingHours > 3 ? "supportive" : "direct";
      if (meetingHours > 3) hints.push("Heavy morning — acknowledge the load");
    } else if (hour >= 14 && hour < 17) {
      tone = "direct";
      if (focusMinutes > 90) hints.push("Good focus session today — reinforce it");
    } else if (hour >= 17 && hour < 20) {
      tone = "calm";
      hints.push("Wind-down time — don't pile on");
    } else {
      tone = "gentle";
      hints.push("Late hour — keep it brief and caring");
    }

    // Weekend adjustment
    const dow = new Date().getDay();
    if (dow === 0 || dow === 6) {
      tone = "calm";
      hints.push("Weekend — lighter, warmer tone");
    }

    const greeting = this.buildGreeting(tone, energyLevel, hour);

    return { tone, energyLevel, greeting, contextHints: hints };
  }

  private buildGreeting(tone: ToneMode, energy: "low" | "medium" | "high", hour: number): string {
    if (tone === "gentle" || energy === "low") {
      return "Take it easy today.";
    }
    if (hour < 10) {
      return energy === "high" ? "Strong start incoming." : "Morning.";
    }
    if (hour >= 17) {
      return "Wrapping up.";
    }
    return "";
  }

  getContextString(meetingHours = 0): string {
    const ctx = this.getTone(meetingHours);
    const lines = [
      `TONE: ${ctx.tone} | ENERGY: ${ctx.energyLevel}`,
      ...ctx.contextHints,
    ];
    if (ctx.greeting) lines.unshift(ctx.greeting);
    return lines.join("\n");
  }
}

export const personalityEngine = new PersonalityEngine();
