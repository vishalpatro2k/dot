/**
 * Apple Health Data Manager
 *
 * Receives health data POSTed by an iOS Shortcut, stores it in SQLite,
 * and produces insights for morning briefs and context strings.
 */

import { memory } from "../memory/store.js";

export interface HealthData {
  date: string; // YYYY-MM-DD
  sleep: {
    totalHours: number;
    inBedHours: number;
    efficiency: number; // 0–100%
    bedtime: string;    // HH:mm
    wakeTime: string;   // HH:mm
    quality?: "poor" | "fair" | "good" | "excellent";
  };
  activity: {
    steps: number;
    activeCalories: number;
    exerciseMinutes: number;
    standHours: number;
    moveGoalPercent: number;
  };
  vitals?: {
    restingHR: number;
    hrv: number;
  };
  receivedAt: string;
}

export interface HealthInsight {
  type: "warning" | "positive" | "neutral";
  icon: string;
  category: "sleep" | "activity" | "recovery";
  message: string;
}

export class HealthDataManager {
  saveHealthData(data: HealthData): void {
    memory.saveKV(`health:${data.date}`, {
      ...data,
      receivedAt: new Date().toISOString(),
    });
    console.log(`✓ Health data saved for ${data.date}`);
  }

  getHealthData(date: string): HealthData | null {
    return memory.getKV<HealthData>(`health:${date}`);
  }

  getLastNightSleep(): HealthData["sleep"] | null {
    const today = new Date().toISOString().split("T")[0];
    const todayData = this.getHealthData(today);
    if (todayData) return todayData.sleep;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yData = this.getHealthData(yesterday.toISOString().split("T")[0]);
    return yData?.sleep ?? null;
  }

  getRecentHealth(days = 7): HealthData[] {
    const results: HealthData[] = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const data = this.getHealthData(d.toISOString().split("T")[0]);
      if (data) results.push(data);
    }
    return results;
  }

  getHealthPatterns(): {
    avgSleepHours: number;
    avgSteps: number;
    avgBedtime: string;
    avgWakeTime: string;
    sleepTrend: "improving" | "declining" | "stable";
    activityTrend: "improving" | "declining" | "stable";
  } {
    const recent = this.getRecentHealth(14);

    if (recent.length < 3) {
      return { avgSleepHours: 0, avgSteps: 0, avgBedtime: "Unknown", avgWakeTime: "Unknown", sleepTrend: "stable", activityTrend: "stable" };
    }

    const avgSleepHours =
      Math.round((recent.reduce((s, d) => s + d.sleep.totalHours, 0) / recent.length) * 10) / 10;
    const avgSteps = Math.round(recent.reduce((s, d) => s + d.activity.steps, 0) / recent.length);

    const lastThree = recent.slice(0, 3);
    const prevThree = recent.slice(3, 6);

    let sleepTrend: "improving" | "declining" | "stable" = "stable";
    let activityTrend: "improving" | "declining" | "stable" = "stable";

    if (prevThree.length >= 3) {
      const rSleep = lastThree.reduce((s, d) => s + d.sleep.totalHours, 0) / 3;
      const pSleep = prevThree.reduce((s, d) => s + d.sleep.totalHours, 0) / 3;
      if (rSleep > pSleep + 0.5) sleepTrend = "improving";
      else if (rSleep < pSleep - 0.5) sleepTrend = "declining";

      const rSteps = lastThree.reduce((s, d) => s + d.activity.steps, 0) / 3;
      const pSteps = prevThree.reduce((s, d) => s + d.activity.steps, 0) / 3;
      if (rSteps > pSteps * 1.15) activityTrend = "improving";
      else if (rSteps < pSteps * 0.85) activityTrend = "declining";
    }

    const avgBedtime = this.avgTime(recent.map((d) => d.sleep.bedtime));
    const avgWakeTime = this.avgTime(recent.map((d) => d.sleep.wakeTime));

    return { avgSleepHours, avgSteps, avgBedtime, avgWakeTime, sleepTrend, activityTrend };
  }

  private avgTime(times: string[]): string {
    const hours = times.filter(Boolean).map((t) => parseInt(t.split(":")[0]));
    if (hours.length === 0) return "Unknown";
    const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
    return `${avg}:00`;
  }

  generateHealthInsights(
    data: HealthData,
    patterns?: ReturnType<HealthDataManager["getHealthPatterns"]>
  ): HealthInsight[] {
    const insights: HealthInsight[] = [];
    const { sleep, activity, vitals } = data;

    // Sleep quantity
    if (sleep.totalHours < 6) {
      insights.push({ type: "warning", icon: "😴", category: "sleep", message: `Only ${sleep.totalHours}h sleep. Consider a lighter pace today.` });
    } else if (sleep.totalHours >= 7.5) {
      insights.push({ type: "positive", icon: "✨", category: "sleep", message: `Solid ${sleep.totalHours}h sleep. Good foundation for today.` });
    }

    // Sleep efficiency
    if (sleep.efficiency > 0 && sleep.efficiency < 75) {
      insights.push({ type: "warning", icon: "🛏️", category: "sleep", message: `Sleep efficiency ${sleep.efficiency}% — restless night?` });
    }

    // Late bedtime
    const bedHour = parseInt(sleep.bedtime?.split(":")[0] ?? "0");
    if (bedHour >= 1 && bedHour < 6) {
      insights.push({ type: "warning", icon: "🌙", category: "sleep", message: `Late night (bed at ${sleep.bedtime}). Might feel it today.` });
    }

    // Steps
    if (activity.steps > 0 && activity.steps < 3000) {
      insights.push({ type: "neutral", icon: "🚶", category: "activity", message: `Low movement yesterday (${activity.steps.toLocaleString()} steps). Try a walk?` });
    } else if (activity.steps >= 10000) {
      insights.push({ type: "positive", icon: "🏃", category: "activity", message: `Great activity yesterday — ${activity.steps.toLocaleString()} steps!` });
    }

    // Exercise
    if (activity.exerciseMinutes >= 30) {
      insights.push({ type: "positive", icon: "💪", category: "activity", message: `${activity.exerciseMinutes}min exercise logged.` });
    }

    // HRV
    if (vitals?.hrv) {
      if (vitals.hrv < 30) {
        insights.push({ type: "warning", icon: "❤️", category: "recovery", message: `Low HRV (${vitals.hrv}ms) — body asking for recovery. Go easy today.` });
      } else if (vitals.hrv > 60) {
        insights.push({ type: "positive", icon: "❤️", category: "recovery", message: `Strong HRV (${vitals.hrv}ms) — well recovered and ready to go.` });
      }
    }

    // Trend-based
    if (patterns) {
      if (patterns.sleepTrend === "declining") {
        insights.push({ type: "warning", icon: "📉", category: "sleep", message: "Sleep trending down this week. Prioritize rest tonight." });
      }
      if (patterns.avgSleepHours > 0 && sleep.totalHours < patterns.avgSleepHours - 1) {
        const diff = (patterns.avgSleepHours - sleep.totalHours).toFixed(1);
        insights.push({ type: "neutral", icon: "📊", category: "sleep", message: `${diff}h below your ${patterns.avgSleepHours}h average. Catch up soon.` });
      }
    }

    return insights;
  }

  getContextString(): string {
    const sleep = this.getLastNightSleep();
    const patterns = this.getHealthPatterns();

    if (!sleep) return "";

    const lines: string[] = ["HEALTH (last night):"];
    lines.push(`Sleep: ${sleep.totalHours}h (bed ${sleep.bedtime}, woke ${sleep.wakeTime})`);
    if (sleep.efficiency > 0) lines.push(`Efficiency: ${sleep.efficiency}%`);

    // Get today's full data for activity
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const fullData = this.getHealthData(today) ?? this.getHealthData(yesterday.toISOString().split("T")[0]);

    if (fullData?.activity.steps > 0) {
      lines.push(`Steps yesterday: ${fullData.activity.steps.toLocaleString()}`);
    }
    if (fullData?.vitals?.hrv) {
      lines.push(`HRV: ${fullData.vitals.hrv}ms`);
    }

    if (patterns.avgSleepHours > 0) {
      lines.push(`Avg sleep: ${patterns.avgSleepHours}h | Sleep trend: ${patterns.sleepTrend}`);
    }

    // Surface insights as text
    if (fullData) {
      const insights = this.generateHealthInsights(fullData, patterns);
      if (insights.length > 0) {
        lines.push("Insights: " + insights.map((i) => i.message).join(" | "));
      }
    }

    return lines.join("\n");
  }
}

export const healthData = new HealthDataManager();
