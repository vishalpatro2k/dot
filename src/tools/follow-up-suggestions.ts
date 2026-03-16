/**
 * Follow-up Suggestions
 *
 * Generates contextual chip suggestions shown after each Dot response.
 * Analyzes what was just discussed and surfaces the most useful next step.
 */

import { focusMode } from "./focus-mode.js";

export interface Suggestion {
  id: string;
  label: string;
  query: string;
  icon?: string;
  type: "action" | "question" | "navigation";
}

export class FollowUpGenerator {
  generate(
    userQuery: string,
    assistantResponse: string,
    ctx?: { meetingsMentioned?: string[]; tasksMentioned?: string[]; peopleMentioned?: string[] }
  ): Suggestion[] {
    const suggestions: Suggestion[] = [];
    const q = userQuery.toLowerCase();
    const r = assistantResponse.toLowerCase();

    // ── Calendar / meetings ────────────────────────────────────────────────
    if (q.includes("day") || q.includes("calendar") || q.includes("meeting") || q.includes("brief")) {
      if (r.includes("heavy") || r.includes("busy") || r.includes("packed") || r.includes("back-to-back")) {
        suggestions.push({ id: "decline-optional", label: "Skip optional", query: "Which meetings can I skip today?", icon: "🗑️", type: "question" });
      }
      // Extract first meeting from response (e.g. "10:30 → Standup")
      const meetMatch = r.match(/(\d{1,2}:\d{2})\s*[→\-]\s*([^\n,]{4,30})/);
      if (meetMatch) {
        const name = meetMatch[2].trim();
        suggestions.push({ id: "prep-next", label: `Prep for ${name.slice(0, 20)}`, query: `Prep me for the ${name}`, icon: "📋", type: "action" });
      }
    }

    // ── Focus ─────────────────────────────────────────────────────────────
    if (q.includes("focus") || r.includes("focus")) {
      const status = focusMode.getStatus();
      if (status.active) {
        suggestions.push({ id: "extend-focus", label: "Extend 30m", query: "Extend focus by 30 minutes", icon: "⏱️", type: "action" });
        suggestions.push({ id: "stop-focus", label: "End focus", query: "Stop focus", icon: "⏹️", type: "action" });
      } else {
        suggestions.push({ id: "start-focus", label: "Start focus", query: "Focus for 90 minutes", icon: "🎯", type: "action" });
      }
    }

    // ── Tasks ──────────────────────────────────────────────────────────────
    if (q.includes("task") || r.includes("task") || r.includes("overdue") || q.includes("plate")) {
      suggestions.push({ id: "add-task", label: "Add task", query: "Add task: ", icon: "➕", type: "action" });
      if (r.includes("overdue")) {
        suggestions.push({ id: "reschedule", label: "Reschedule overdue", query: "Help me reschedule overdue tasks", icon: "📅", type: "action" });
      }
    }

    // ── People ─────────────────────────────────────────────────────────────
    if (ctx?.peopleMentioned?.length) {
      const person = ctx.peopleMentioned[0];
      suggestions.push({ id: `person-${person}`, label: `More on ${person}`, query: `What's my history with ${person}?`, icon: "👤", type: "question" });
    }

    // ── Recap / review ────────────────────────────────────────────────────
    if (q.includes("recap") || q.includes("review") || q.includes("how was")) {
      suggestions.push({ id: "tomorrow", label: "Tomorrow?", query: "What's tomorrow look like?", icon: "📅", type: "question" });
      suggestions.push({ id: "set-goal", label: "Set a goal", query: "Show my goals progress", icon: "🎯", type: "action" });
    }

    // ── Declined / freed slot ─────────────────────────────────────────────
    if (r.includes("declined") || r.includes("cancelled") || r.includes("removed")) {
      suggestions.push({ id: "block-freed", label: "Block for focus", query: "Block that time for focus", icon: "🎯", type: "action" });
    }

    // ── Scheduling ────────────────────────────────────────────────────────
    if (q.includes("schedule") || q.includes("slot") || q.includes("free time")) {
      suggestions.push({ id: "book-it", label: "Book it", query: "Create that event", icon: "📅", type: "action" });
    }

    // ── Fallback ──────────────────────────────────────────────────────────
    if (suggestions.length === 0) {
      suggestions.push({ id: "more", label: "Tell me more", query: "Tell me more about that", icon: "💬", type: "question" });
    }

    return suggestions.slice(0, 4);
  }

  quickActions(): Suggestion[] {
    return [
      { id: "brief", label: "Brief", query: "Morning brief", icon: "☀️", type: "action" },
      { id: "focus", label: "Focus", query: "Start focus for 90 minutes", icon: "🎯", type: "action" },
      { id: "tasks", label: "Tasks", query: "What's on my plate?", icon: "📋", type: "navigation" },
      { id: "add", label: "Add", query: "Add task: ", icon: "➕", type: "action" },
    ];
  }
}

export const followUpGenerator = new FollowUpGenerator();
