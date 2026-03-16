/**
 * Context Bar
 *
 * Returns the current real-time state (focus session, live meeting, next meeting)
 * to drive the compact status bar shown when Dot is collapsed.
 */

import { calendar } from "./calendar.js";
import { focusMode } from "./focus-mode.js";

export interface ContextBarState {
  leftText: string;
  rightText?: string;
  status: "focus" | "meeting" | "busy" | "free";
  statusColor: "green" | "red" | "yellow" | "gray";
}

export async function getContextBarState(): Promise<ContextBarState> {
  const now = new Date();

  // Active focus session wins
  const focus = focusMode.getStatus();
  if (focus.active) {
    return {
      leftText: `In focus · ${focus.remainingMinutes}m left`,
      rightText: focus.session?.task,
      status: "focus",
      statusColor: "green",
    };
  }

  // Check today's events for current / next
  let events: Awaited<ReturnType<typeof calendar.getTodaysEvents>> = [];
  try {
    events = await calendar.getTodaysEvents();
  } catch {
    // Calendar unavailable — fall through to free state
  }

  const current = events.find((e) => !e.isAllDay && e.start <= now && e.end > now);
  if (current) {
    const minsLeft = Math.round((current.end.getTime() - now.getTime()) / 60_000);
    return {
      leftText: `In: ${current.title.slice(0, 28)}`,
      rightText: `${minsLeft}m left`,
      status: "meeting",
      statusColor: "red",
    };
  }

  const next = events.find((e) => !e.isAllDay && e.start > now);
  if (next) {
    const minsUntil = Math.round((next.start.getTime() - now.getTime()) / 60_000);
    const timeStr = next.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (minsUntil <= 60) {
      return {
        leftText: `Next: ${next.title.slice(0, 26)}`,
        rightText: minsUntil <= 5 ? "Starting soon" : `in ${minsUntil}m`,
        status: minsUntil <= 15 ? "busy" : "free",
        statusColor: minsUntil <= 15 ? "yellow" : "gray",
      };
    }
    if (now.getHours() < 18) {
      return { leftText: "Calendar clear", rightText: `Next at ${timeStr}`, status: "free", statusColor: "green" };
    }
  }

  if (now.getHours() >= 18) {
    return { leftText: "After hours", status: "free", statusColor: "gray" };
  }

  return { leftText: "Calendar clear", status: "free", statusColor: "green" };
}
