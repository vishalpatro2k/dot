/**
 * Weekly Review Generator
 *
 * Aggregates calendar, task, and wellness data from the past 7 days
 * into a structured review object the LLM formats naturally.
 */

import { wellness } from "./wellness-analyzer.js";
import { notionTasks } from "./notion-tasks.js";

export interface WeeklyReview {
  weekOf: string;
  summary: string;
  meetings: {
    total: number;
    totalHours: number;
    avgPerDay: number;
    busiestDay: string;
    lightestDay: string;
    comparedToLastWeek: number; // % change
  };
  tasks: {
    completed: number;
    overdue: number;
    topCompleted: string[];
  };
  focus: {
    focusHours: number;
    avgFocusBlockLength: number;
    bestFocusDay: string;
  };
  wellbeing: {
    avgMeetingHours: number;
    daysWithLunchProtected: number;
    backToBackDays: number;
    lateFinishDays: number;
  };
  insights: string[];
}

export async function generateWeeklyReview(): Promise<WeeklyReview> {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const weekOf = startOfWeek.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const [weekComparison, dayHistory, patterns] = await Promise.all([
    wellness.getWeekComparison(),
    Promise.resolve(wellness.getDayHistory(7)),
    Promise.resolve(wellness.getPatterns()),
  ]);

  // Task stats (graceful degradation if not configured)
  let completedTasks: { title: string }[] = [];
  let overdueTasks: { id: string }[] = [];
  if (notionTasks.isConfigured()) {
    [completedTasks, overdueTasks] = await Promise.all([
      notionTasks.getCompletedThisWeek(),
      notionTasks.getOverdueTasks(),
    ]);
  }

  // Focus aggregation
  const totalFocusHours = dayHistory.reduce((s, d) => s + d.focusHours, 0);
  const totalFocusBlocks = dayHistory.reduce((s, d) => s + d.focusBlocks, 0);
  const avgFocusBlockLength =
    totalFocusBlocks > 0
      ? Math.round((totalFocusHours / totalFocusBlocks) * 10) / 10
      : 0;
  const bestFocusDay =
    dayHistory.length > 0
      ? dayHistory.reduce((best, d) => (d.focusHours > best.focusHours ? d : best), dayHistory[0])
      : null;

  // Wellbeing stats
  const daysWithLunchProtected = dayHistory.filter((d) => d.lunchProtected).length;
  const backToBackDays = dayHistory.filter((d) => d.backToBackCount >= 3).length;
  const lateFinishDays = dayHistory.filter((d) => {
    if (!d.lastMeeting) return false;
    const isPM = d.lastMeeting.includes("PM");
    const hour = parseInt(d.lastMeeting.split(":")[0]);
    const hour24 = isPM && hour !== 12 ? hour + 12 : hour;
    return hour24 >= 18;
  }).length;

  // Insights
  const insights: string[] = [];

  if (weekComparison.change > 25) {
    insights.push(
      `Meeting load up ${weekComparison.change}% from last week. Worth declining some next week.`
    );
  } else if (weekComparison.change < -25) {
    insights.push(
      `${Math.abs(weekComparison.change)}% fewer meetings than last week. Nice recovery.`
    );
  }

  if (completedTasks.length >= 10) {
    insights.push(`Solid execution — ${completedTasks.length} tasks completed this week.`);
  } else if (completedTasks.length > 0) {
    insights.push(`${completedTasks.length} task${completedTasks.length > 1 ? "s" : ""} closed out.`);
  }

  if (daysWithLunchProtected >= 4) {
    insights.push(`Lunch protected ${daysWithLunchProtected} days. Keep that up.`);
  } else if (daysWithLunchProtected <= 1) {
    insights.push("Lunch was blocked most days. Try to protect it next week.");
  }

  if (backToBackDays >= 3) {
    insights.push(`${backToBackDays} days with back-to-backs. That drains fast.`);
  }

  const focusRounded = Math.round(totalFocusHours * 10) / 10;
  if (focusRounded >= 10) {
    insights.push(`${focusRounded}h of focus time — well balanced week.`);
  } else if (focusRounded < 5 && dayHistory.length >= 3) {
    insights.push(`Only ${focusRounded}h of focus time. Try blocking deep work slots next week.`);
  }

  if (patterns.busiestDayOfWeek) {
    insights.push(`${patterns.busiestDayOfWeek}s remain your heaviest meeting day.`);
  }

  // Summary
  const hrs = weekComparison.thisWeek.hours;
  const mtgs = weekComparison.thisWeek.meetings;
  const summary =
    hrs >= 30
      ? `Heavy week — ${hrs}h across ${mtgs} meetings.`
      : hrs >= 20
      ? `Solid week with ${mtgs} meetings (${hrs}h total).`
      : `Light meeting week — ${hrs}h total. Good space for deep work.`;

  return {
    weekOf,
    summary,
    meetings: {
      total: mtgs,
      totalHours: hrs,
      avgPerDay: Math.round((hrs / 5) * 10) / 10,
      busiestDay: weekComparison.busiestDay,
      lightestDay: patterns.lightestDayOfWeek,
      comparedToLastWeek: weekComparison.change,
    },
    tasks: {
      completed: completedTasks.length,
      overdue: overdueTasks.length,
      topCompleted: (completedTasks as any[]).slice(0, 3).map((t: any) => t.title),
    },
    focus: {
      focusHours: focusRounded,
      avgFocusBlockLength,
      bestFocusDay: bestFocusDay?.date
        ? new Date(bestFocusDay.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" })
        : "Unknown",
    },
    wellbeing: {
      avgMeetingHours: patterns.avgMeetingHours,
      daysWithLunchProtected,
      backToBackDays,
      lateFinishDays,
    },
    insights,
  };
}
