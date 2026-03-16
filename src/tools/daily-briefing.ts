/**
 * Daily Briefing
 *
 * Generates structured morning briefs and day recaps.
 * The output is passed as context to the LLM which formats it naturally.
 */

import { calendar } from "./calendar.js";
import { gmail } from "./gmail.js";
import { wellness } from "./wellness-analyzer.js";
import { healthData } from "./health-data.js";

export async function getMorningBriefContext(): Promise<string> {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const hour = now.getHours();

  const [{ stats, insights, events }, yesterday, emailData, weekComparison] = await Promise.all([
    wellness.analyzeTodayCalendar(),
    wellness.analyzeYesterday(),
    gmail.getSmartInbox(30),
    wellness.getWeekComparison(),
  ]);

  // Health data (synchronous — reads from local SQLite)
  const sleep = healthData.getLastNightSleep();
  const healthPatterns = healthData.getHealthPatterns();

  const patterns = wellness.getPatterns();

  const lines: string[] = [];
  lines.push(`MORNING BRIEF — ${dayOfWeek}, ${dateStr}`);
  lines.push(`Current time: ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
  lines.push("");

  // Today overview
  lines.push("TODAY'S SCHEDULE:");
  if (stats.meetingCount === 0) {
    lines.push("No meetings scheduled.");
  } else {
    lines.push(`${stats.meetingCount} meetings, ${stats.meetingHours}h total`);
    if (stats.firstMeeting) lines.push(`First: ${stats.firstMeeting} → Last: ${stats.lastMeeting}`);
    lines.push("");
    for (const e of events.filter((ev) => !ev.isAllDay)) {
      const t = e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const tags: string[] = [];
      if (e.duration >= 60) tags.push("long");
      if (e.duration <= 15) tags.push("quick");
      if (!stats.lunchProtected && e.start.getHours() === 12) tags.push("lunch-hour");
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      lines.push(`${t} → ${e.title}${tagStr}`);
    }
  }

  // Wellness insights
  if (insights.length > 0) {
    lines.push("");
    lines.push("WELLNESS FLAGS:");
    for (const ins of insights) {
      lines.push(`${ins.icon} ${ins.title}: ${ins.message}`);
    }
  }

  // Email
  lines.push("");
  lines.push("EMAIL:");
  lines.push(`${emailData.totalUnread.toLocaleString()} unread total`);
  if (emailData.actionable.length > 0) {
    lines.push(`${emailData.actionable.length} need attention:`);
    for (const e of emailData.actionable.slice(0, 3)) {
      const tag = e.category === "money" ? "[payment]" : e.category === "urgent" ? "[urgent]" : "[reply needed]";
      lines.push(`  ${e.fromName}: ${e.subject.slice(0, 45)} ${tag}`);
    }
  } else {
    lines.push("Nothing actionable.");
  }

  // Week context
  lines.push("");
  lines.push("WEEK CONTEXT:");
  lines.push(`This week: ${weekComparison.thisWeek.meetings} meetings, ${weekComparison.thisWeek.hours}h`);
  lines.push(`Last week: ${weekComparison.lastWeek.meetings} meetings, ${weekComparison.lastWeek.hours}h`);
  if (weekComparison.change !== 0) {
    lines.push(`Change: ${weekComparison.change > 0 ? "+" : ""}${weekComparison.change}%`);
  }

  // Yesterday context
  if (yesterday.stats.meetingCount > 0) {
    lines.push("");
    lines.push("YESTERDAY:");
    lines.push(`${yesterday.stats.meetingHours}h in meetings, ${yesterday.stats.meetingCount} meetings`);
    if (yesterday.stats.lastMeeting) lines.push(`Finished at: ${yesterday.stats.lastMeeting}`);
  }

  // Patterns
  if (patterns.avgMeetingHours > 0) {
    lines.push("");
    lines.push("LEARNED PATTERNS:");
    lines.push(`Average meeting day: ${patterns.avgMeetingHours}h`);
    if (patterns.busiestDayOfWeek) lines.push(`Busiest day: ${patterns.busiestDayOfWeek}`);
    if (patterns.lightestDayOfWeek) lines.push(`Lightest day: ${patterns.lightestDayOfWeek}`);
    lines.push(`Lunch protected: ${patterns.lunchProtectedPercent}% of days`);
  }

  // Health
  if (sleep) {
    lines.push("");
    lines.push("HEALTH (last night):");
    lines.push(`Sleep: ${sleep.totalHours}h (bed ${sleep.bedtime || "?"}, woke ${sleep.wakeTime || "?"})`);
    if (sleep.efficiency > 0) lines.push(`Efficiency: ${sleep.efficiency}%`);
    if (healthPatterns.avgSleepHours > 0) {
      lines.push(`Avg sleep: ${healthPatterns.avgSleepHours}h | Trend: ${healthPatterns.sleepTrend}`);
    }

    // Combine sleep + calendar for compound insight
    if (sleep.totalHours < 6 && stats.meetingHours >= 5) {
      lines.push(`⚠️ Short sleep (${sleep.totalHours}h) + heavy calendar (${stats.meetingHours}h) — tough combo`);
    } else if (sleep.totalHours >= 7.5 && stats.meetingCount <= 3) {
      lines.push("✨ Well rested + light calendar — great day for deep work");
    }
  }

  return lines.join("\n");
}

export async function getDayRecapContext(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const [{ stats, insights, events }, emailData] = await Promise.all([
    wellness.analyzeTodayCalendar(),
    gmail.getSmartInbox(50),
  ]);

  // Get tomorrow's events
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEvents = await calendar.getEventsForDate(tomorrow);
  const tomorrowMeetings = tomorrowEvents.filter((e) => !e.isAllDay);

  // Auto-detect positives and improvements
  const whatWentWell: string[] = [];
  const couldImprove: string[] = [];

  if (stats.lunchProtected) whatWentWell.push("Protected lunch break");
  if (stats.focusBlocks >= 2) whatWentWell.push(`${stats.focusBlocks} focus blocks`);
  if (stats.backToBackCount === 0 && stats.meetingCount > 3) whatWentWell.push("Good buffer between meetings");
  if (stats.meetingCount <= 3) whatWentWell.push("Manageable meeting load");

  if (stats.backToBackCount >= 3) couldImprove.push(`${stats.backToBackCount} back-to-backs — add buffers`);
  if (!stats.lunchProtected) couldImprove.push("Lunch blocked — protect it tomorrow");

  // Save stats for pattern learning
  wellness.saveDay(stats);

  // Health recap
  const todaySleep = healthData.getLastNightSleep();
  const healthPatterns = healthData.getHealthPatterns();

  const lines: string[] = [];
  lines.push(`DAY RECAP — ${dateStr}`);
  lines.push("");

  lines.push("TODAY'S STATS:");
  lines.push(`${stats.meetingCount} meetings, ${stats.meetingHours}h total`);
  if (stats.focusBlocks > 0) lines.push(`${stats.focusHours}h focus time across ${stats.focusBlocks} blocks`);
  lines.push(`Lunch: ${stats.lunchProtected ? "protected ✓" : "blocked ✗"}`);
  if (stats.backToBackCount > 0) lines.push(`Back-to-backs: ${stats.backToBackCount}`);
  if (stats.firstMeeting) lines.push(`Hours: ${stats.firstMeeting} → ${stats.lastMeeting}`);
  if (stats.longestMeeting >= 60) {
    const longest = events.find((e) => e.duration === stats.longestMeeting);
    if (longest) lines.push(`Longest: ${longest.title} (${Math.round(stats.longestMeeting / 60 * 10) / 10}h)`);
  }

  // Email
  lines.push("");
  lines.push("EMAIL:");
  lines.push(`${emailData.actionable.length} actionable, ${emailData.ignored.reduce((s, i) => s + i.count, 0)} filtered`);

  // Reflection
  if (whatWentWell.length > 0) {
    lines.push("");
    lines.push("WHAT WENT WELL:");
    for (const w of whatWentWell) lines.push(`✓ ${w}`);
  }
  if (couldImprove.length > 0) {
    lines.push("");
    lines.push("COULD IMPROVE:");
    for (const c of couldImprove) lines.push(`→ ${c}`);
  }

  // Wellness insights
  if (insights.length > 0) {
    lines.push("");
    lines.push("WELLNESS NOTES:");
    for (const ins of insights) lines.push(`${ins.icon} ${ins.message}`);
  }

  // Health
  if (todaySleep) {
    lines.push("");
    lines.push("HEALTH (last night):");
    lines.push(`Sleep: ${todaySleep.totalHours}h`);
    if (healthPatterns.avgSleepHours > 0 && todaySleep.totalHours < healthPatterns.avgSleepHours - 0.5) {
      lines.push(`Below your ${healthPatterns.avgSleepHours}h average — consider early night`);
    }
    if (healthPatterns.sleepTrend === "declining") {
      lines.push("Sleep trending down this week");
    }
  }

  // Tomorrow preview
  if (tomorrowMeetings.length > 0) {
    const first = tomorrowMeetings[0];
    const firstTime = first.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    lines.push("");
    lines.push("TOMORROW:");
    lines.push(`${tomorrowMeetings.length} meetings, first at ${firstTime}`);
  } else {
    lines.push("");
    lines.push("TOMORROW: No meetings scheduled.");
  }

  return lines.join("\n");
}
