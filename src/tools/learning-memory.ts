/**
 * Learning Memory
 *
 * Tracks usage patterns, conversation topics, and day reflections
 * over time so Dot can personalize responses.
 */

import { memory } from "../memory/store.js";

export interface UsagePattern {
  mostActiveTime: string;
  topTopics: string[];
  avgEnergy: number;
}

export class LearningMemory {
  /**
   * Call after every LLM response to track what the user asks about.
   */
  learn(query: string): void {
    const topics = this.extractTopics(query);

    // Track topic frequencies
    const questionCounts = memory.getKV<Record<string, number>>("patterns:questions") || {};
    for (const topic of topics) {
      questionCounts[topic] = (questionCounts[topic] || 0) + 1;
    }
    memory.saveKV("patterns:questions", questionCounts);

    // Track time-of-day usage
    const hour = new Date().getHours();
    const slot =
      hour < 6 ? "night" :
      hour < 9 ? "early_morning" :
      hour < 12 ? "morning" :
      hour < 14 ? "midday" :
      hour < 17 ? "afternoon" :
      hour < 21 ? "evening" : "night";

    const timeUsage = memory.getKV<Record<string, number>>("patterns:usage_times") || {};
    timeUsage[slot] = (timeUsage[slot] || 0) + 1;
    memory.saveKV("patterns:usage_times", timeUsage);
  }

  private extractTopics(query: string): string[] {
    const q = query.toLowerCase();
    const topics: string[] = [];
    if (/meeting|calendar|schedule/.test(q)) topics.push("calendar");
    if (/email|inbox|gmail/.test(q)) topics.push("email");
    if (/tired|exhausted|busy|heavy/.test(q)) topics.push("wellness");
    if (/focus|deep work/.test(q)) topics.push("focus");
    if (/break|lunch/.test(q)) topics.push("breaks");
    if (/tomorrow|next week|plan/.test(q)) topics.push("planning");
    if (/yesterday|recap|how was/.test(q)) topics.push("review");
    if (/morning|brief|today look/.test(q)) topics.push("brief");
    return topics;
  }

  getUsagePatterns(): UsagePattern {
    const timeUsage = memory.getKV<Record<string, number>>("patterns:usage_times") || {};
    const questionCounts = memory.getKV<Record<string, number>>("patterns:questions") || {};
    const avgEnergy = memory.getKV<number>("patterns:avg_energy") || 3;

    const mostActiveTime = Object.entries(timeUsage).sort((a, b) => b[1] - a[1])[0]?.[0] || "morning";
    const topTopics = Object.entries(questionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    return { mostActiveTime, topTopics, avgEnergy };
  }

  generateContextForPrompt(): string {
    const patterns = this.getUsagePatterns();
    const lines: string[] = ["USER PATTERNS (learned over time):"];

    const timeLabel: Record<string, string> = {
      early_morning: "early mornings (before 9am)",
      morning: "mornings",
      midday: "midday",
      afternoon: "afternoons",
      evening: "evenings",
      night: "late nights",
    };

    lines.push(`- Most active: ${timeLabel[patterns.mostActiveTime] ?? patterns.mostActiveTime}`);
    if (patterns.topTopics.length > 0) {
      lines.push(`- Common topics: ${patterns.topTopics.join(", ")}`);
    }
    lines.push(`- Avg energy level: ${patterns.avgEnergy.toFixed(1)}/5`);

    return lines.join("\n");
  }
}

export const learningMemory = new LearningMemory();
