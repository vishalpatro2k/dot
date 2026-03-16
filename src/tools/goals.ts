/**
 * Goal Tracking
 *
 * Lets users set daily and weekly goals (focus hours, tasks completed,
 * meetings capped, lunch protected) and tracks progress against them.
 */

import { memory } from "../memory/store.js";
import { focusMode } from "./focus-mode.js";

export type GoalPeriod = "daily" | "weekly";
export type GoalType = "focus_hours" | "tasks_completed" | "meetings_max" | "lunch_protected";

export interface Goal {
  id: string;
  type: GoalType;
  period: GoalPeriod;
  target: number;
  label: string;
  createdAt: string;
}

export interface GoalProgress {
  goal: Goal;
  current: number;
  percent: number;
  met: boolean;
}

export class GoalTracker {
  private storageKey = "goals:list";

  getGoals(): Goal[] {
    return memory.getKV<Goal[]>(this.storageKey) ?? [];
  }

  addGoal(type: GoalType, period: GoalPeriod, target: number): Goal {
    const goals = this.getGoals();

    // Replace existing goal of same type+period
    const filtered = goals.filter((g) => !(g.type === type && g.period === period));

    const goal: Goal = {
      id: `goal-${Date.now()}`,
      type,
      period,
      target,
      label: this.labelFor(type, period, target),
      createdAt: new Date().toISOString(),
    };

    filtered.push(goal);
    memory.saveKV(this.storageKey, filtered);
    return goal;
  }

  removeGoal(id: string): boolean {
    const goals = this.getGoals();
    const filtered = goals.filter((g) => g.id !== id);
    if (filtered.length === goals.length) return false;
    memory.saveKV(this.storageKey, filtered);
    return true;
  }

  getProgress(
    meetingCountToday = 0,
    tasksCompletedToday = 0,
    lunchProtectedToday = false,
    meetingCountWeek = 0,
    tasksCompletedWeek = 0,
  ): GoalProgress[] {
    const goals = this.getGoals();
    const focusMinutesToday = focusMode.getTodaysFocusMinutes();
    const focusHoursToday = focusMinutesToday / 60;

    // Weekly focus: sum last 7 days
    const focusStats = focusMode.getStats();
    const focusHoursWeek = focusStats.thisWeekMinutes / 60;

    return goals.map((g) => {
      let current = 0;

      if (g.type === "focus_hours") {
        current = g.period === "daily" ? focusHoursToday : focusHoursWeek;
      } else if (g.type === "tasks_completed") {
        current = g.period === "daily" ? tasksCompletedToday : tasksCompletedWeek;
      } else if (g.type === "meetings_max") {
        // For meetings_max, lower is better — met = current <= target
        current = g.period === "daily" ? meetingCountToday : meetingCountWeek;
        const met = current <= g.target;
        const percent = g.target > 0 ? Math.min(100, Math.round((current / g.target) * 100)) : 100;
        return { goal: g, current, percent, met };
      } else if (g.type === "lunch_protected") {
        // Binary: 0 or 1
        current = lunchProtectedToday ? 1 : 0;
        return { goal: g, current, percent: current * 100, met: lunchProtectedToday };
      }

      const percent = g.target > 0 ? Math.min(100, Math.round((current / g.target) * 100)) : 0;
      const met = current >= g.target;
      return { goal: g, current, percent, met };
    });
  }

  getContextString(
    meetingCountToday = 0,
    tasksCompletedToday = 0,
    lunchProtectedToday = false,
  ): string {
    const goals = this.getGoals();
    if (goals.length === 0) return "";

    const progress = this.getProgress(meetingCountToday, tasksCompletedToday, lunchProtectedToday);
    const lines = progress.map((p) => {
      const bar = p.met ? "✓" : `${p.percent}%`;
      return `${p.goal.label}: ${bar} (${this.formatCurrent(p)})`;
    });

    return `GOALS\n${lines.join("\n")}`;
  }

  private formatCurrent(p: GoalProgress): string {
    if (p.goal.type === "focus_hours") {
      return `${p.current.toFixed(1)}h / ${p.goal.target}h`;
    }
    if (p.goal.type === "lunch_protected") {
      return p.current === 1 ? "protected" : "blocked";
    }
    return `${p.current} / ${p.goal.target}`;
  }

  private labelFor(type: GoalType, period: GoalPeriod, target: number): string {
    const p = period === "daily" ? "Daily" : "Weekly";
    switch (type) {
      case "focus_hours": return `${p} focus ${target}h`;
      case "tasks_completed": return `${p} tasks ${target}`;
      case "meetings_max": return `${p} meetings ≤ ${target}`;
      case "lunch_protected": return `${p} lunch protected`;
    }
  }
}

export const goalTracker = new GoalTracker();
