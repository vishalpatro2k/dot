/**
 * Personal Agent
 *
 * Combines smart LLM routing, prompt caching, calendar + email context,
 * wellness analysis, learning memory, and morning brief / day recap.
 */

import { SmartRouter } from "./llm/router.js";
import { calendar } from "./tools/calendar.js";
import { notion } from "./tools/notion.js";
import { slack } from "./tools/slack.js";
import { gmail } from "./tools/gmail.js";
import { memory } from "./memory/store.js";
import { learningMemory } from "./tools/learning-memory.js";
import { getMorningBriefContext, getDayRecapContext } from "./tools/daily-briefing.js";
import { healthData } from "./tools/health-data.js";
import { notionTasks } from "./tools/notion-tasks.js";
import { generateWeeklyReview } from "./tools/weekly-review.js";
import { focusMode } from "./tools/focus-mode.js";
import { meetingPrep } from "./tools/meeting-prep.js";
import { smartScheduler } from "./tools/smart-scheduling.js";
import { personalityEngine } from "./tools/personality-engine.js";
import { goalTracker } from "./tools/goals.js";
import { predictiveNudges } from "./tools/predictive-nudges.js";
import { actionExecutor } from "./tools/action-executor.js";

export interface AgentResponse {
  answer: string;
  model: string;
  cost: number;
  cached: boolean;
}

export class PersonalAgent {
  private router: SmartRouter;
  private initialized = false;

  constructor() {
    this.router = new SmartRouter({ debug: true });
  }

  async init(): Promise<void> {
    console.log("\n🤖 Initializing Personal Agent...\n");

    memory.init();
    await calendar.init();
    await notion.init();
    await slack.init();
    await gmail.init();
    await notionTasks.init();

    this.initialized = true;
    console.log("\n✓ Agent ready!\n");
  }

  async ask(query: string): Promise<AgentResponse> {
    if (!this.initialized) await this.init();

    const notionDate = this.detectDateFromQuery(query);

    // Build context — morning brief and day recap get richer structured context
    const isBrief = this.isMorningBriefRequest(query);
    const isRecap = this.isDayRecapRequest(query);

    const isWeeklyReview = this.isWeeklyReviewRequest(query);
    const isFocus = this.isFocusRequest(query);
    const isMeetingPrep = this.isMeetingPrepRequest(query);
    const isScheduling = this.isSchedulingRequest(query);
    const isGoals = this.isGoalsRequest(query);
    const isNudges = this.isNudgesRequest(query);
    const isAction = this.isActionRequest(query);

    const skipStandardContext = isBrief || isRecap || isFocus || isMeetingPrep || isScheduling;

    const [calendarContext, notionContext, slackContext, emailContext, healthContext, tasksContext] = await Promise.all([
      skipStandardContext ? Promise.resolve("") : calendar.getContextString().catch(() => ""),
      notion.getContextString(notionDate).catch(() => ""),
      slack.getContextString().catch(() => "Slack unavailable"),
      skipStandardContext ? Promise.resolve("") : gmail.getContextString().catch(() => ""),
      skipStandardContext ? Promise.resolve("") : Promise.resolve(healthData.getContextString()),
      skipStandardContext || isWeeklyReview ? Promise.resolve("") : notionTasks.getContextString().catch(() => ""),
    ]);

    // For brief/recap, fetch the richer structured context; for weekly review, generate that
    let structuredContext: string | undefined;
    if (isBrief) {
      structuredContext = await getMorningBriefContext().catch(() => undefined);
    } else if (isRecap) {
      structuredContext = await getDayRecapContext().catch(() => undefined);
    } else if (isWeeklyReview) {
      const review = await generateWeeklyReview().catch(() => null);
      if (review) {
        structuredContext = `WEEKLY REVIEW — week of ${review.weekOf}\n\n${JSON.stringify(review, null, 2)}`;
      }
    } else if (isFocus) {
      structuredContext = await this.handleFocusCommand(query).catch(() => undefined);
    } else if (isMeetingPrep) {
      const meetingQuery = this.extractMeetingQuery(query);
      const ctx = await meetingPrep.prepareForMeeting(meetingQuery).catch(() => null);
      if (ctx) structuredContext = `MEETING PREP\n\n${meetingPrep.formatPrepContext(ctx)}`;
    } else if (isScheduling) {
      structuredContext = await this.handleSchedulingQuery(query).catch(() => undefined);
    } else if (isGoals) {
      structuredContext = this.handleGoalsCommand(query);
    } else if (isNudges) {
      structuredContext = await predictiveNudges.getContextString().catch(() => undefined);
    } else if (isAction) {
      structuredContext = await this.handleActionCommand(query).catch(() => undefined);
    }

    const combinedCalendar = structuredContext
      ? structuredContext
      : [calendarContext, notionContext].filter(Boolean).join("\n\n") || "No calendar data.";

    const learnedContext = learningMemory.generateContextForPrompt();
    const personalityContext = personalityEngine.getContextString();
    const goalsContext = isGoals ? "" : goalTracker.getContextString();
    const memoryContext = [memory.getContextString(), learnedContext, goalsContext].filter(Boolean).join("\n\n");

    memory.logConversation("user", query);

    const response = await this.router.chatWithContext(query, {
      calendar: combinedCalendar,
      slack: slackContext,
      email: (!isBrief && !isRecap && emailContext) ? emailContext : undefined,
      health: (!isBrief && !isRecap && healthContext) ? healthContext : undefined,
      tasks: (!isBrief && !isRecap && tasksContext) ? tasksContext : undefined,
      memory: [memoryContext, personalityContext].filter(Boolean).join("\n\n") || undefined,
    });

    memory.logConversation("assistant", response.content, response.model, response.estimatedCost);
    this.extractAndRemember(query, response.content);

    // Update learning memory
    learningMemory.learn(query);

    return {
      answer: response.content,
      model: response.model.includes("haiku") ? "Haiku" : "Sonnet",
      cost: response.estimatedCost,
      cached: response.cacheReadTokens > 0,
    };
  }

  async morningBrief(): Promise<AgentResponse> {
    return this.ask("Give me my morning brief.");
  }

  async status(): Promise<AgentResponse> {
    return this.ask("Quick status: What's my next meeting and any urgent unread messages?");
  }

  private isMorningBriefRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("morning brief") ||
      q.includes("morning briefing") ||
      q.includes("today look") ||
      q.includes("what's today") ||
      q.includes("how is my day") ||
      q.includes("how's my day") ||
      q.includes("daily brief") ||
      q.includes("give me my brief") ||
      (q.includes("morning") && (q.includes("brief") || q.includes("overview")))
    );
  }

  private isWeeklyReviewRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      (q.includes("week") && (q.includes("review") || q.includes("how was") || q.includes("summary") || q.includes("recap"))) ||
      q.includes("weekly review") ||
      q.includes("how was my week") ||
      q.includes("week in review")
    );
  }

  private isFocusRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("focus mode") ||
      q.includes("start focus") ||
      q.includes("stop focus") ||
      q.includes("end focus") ||
      q.includes("extend focus") ||
      q.includes("focus session") ||
      q.includes("focus stats") ||
      q.includes("focus status") ||
      q.includes("deep work") ||
      /^focus\b/.test(q) || // "Focus for X mins", "Focus 90 mins on Y"
      (q.includes("focus") && /\d+\s*(min|hour|hr|h\b)/.test(q)) || // "focus 30 minutes"
      (q.includes("focus") && (q.includes("start") || q.includes("stop") || q.includes("end") || q.includes("how long") || q.includes("stats")))
    );
  }

  private isMeetingPrepRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("prep for") ||
      q.includes("prepare for") ||
      q.includes("meeting prep") ||
      q.includes("meeting with") ||
      (q.includes("meeting") && (q.includes("notes") || q.includes("context") || q.includes("prep") || q.includes("before")))
    );
  }

  private isSchedulingRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("when can i") ||
      q.includes("find me a slot") ||
      q.includes("free slot") ||
      q.includes("schedule a") ||
      q.includes("suggest a time") ||
      q.includes("best time") ||
      q.includes("focus block") ||
      q.includes("block time") ||
      q.includes("check conflict") ||
      (q.includes("time") && (q.includes("available") || q.includes("free") || q.includes("open"))) ||
      (q.includes("schedule") && (q.includes("find") || q.includes("suggest") || q.includes("when")))
    );
  }

  private isGoalsRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("set goal") ||
      q.includes("my goal") ||
      q.includes("goal progress") ||
      q.includes("goals") ||
      q.includes("remove goal") ||
      q.includes("delete goal") ||
      (q.includes("goal") && (q.includes("track") || q.includes("set") || q.includes("check") || q.includes("how am i")))
    );
  }

  private isNudgesRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("nudge") ||
      q.includes("insight") ||
      q.includes("burnout") ||
      q.includes("tomorrow look") ||
      q.includes("what's tomorrow") ||
      q.includes("how will tomorrow") ||
      q.includes("energy today") ||
      q.includes("pattern")
    );
  }

  private isActionRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("decline") ||
      q.includes("reject") ||
      q.includes("add task") ||
      q.includes("create task") ||
      q.includes("remind me to") ||
      (q.includes("can't make") && q.includes("meeting"))
    );
  }

  private handleGoalsCommand(query: string): string {
    // Remove / delete goal
    const removeMatch = query.match(/(?:remove|delete)\s+goal[:\s]+(.+)/i);
    if (removeMatch) {
      const goals = goalTracker.getGoals();
      const label = removeMatch[1].trim().toLowerCase();
      const found = goals.find((g) => g.label.toLowerCase().includes(label) || g.id === label);
      if (found) {
        goalTracker.removeGoal(found.id);
        return `GOALS\n\nRemoved: ${found.label}`;
      }
      return `GOALS\n\nNo goal found matching "${removeMatch[1]}"`;
    }

    // Set goal patterns: "set goal: focus 2h daily", "set weekly goal: 5 tasks"
    const setMatch = query.match(/set\s+(?:a\s+)?(?:(daily|weekly)\s+)?goal[:\s]+(.+)/i);
    if (setMatch) {
      const period = (setMatch[1]?.toLowerCase() ?? "daily") as "daily" | "weekly";
      const spec = setMatch[2].toLowerCase();

      if (/focus\s+(\d+(?:\.\d+)?)\s*h/i.test(spec)) {
        const hrs = parseFloat(spec.match(/focus\s+(\d+(?:\.\d+)?)/i)![1]);
        const goal = goalTracker.addGoal("focus_hours", period, hrs);
        return `GOALS\n\nSet: ${goal.label}`;
      }
      if (/(\d+)\s+task/i.test(spec)) {
        const n = parseInt(spec.match(/(\d+)/i)![1]);
        const goal = goalTracker.addGoal("tasks_completed", period, n);
        return `GOALS\n\nSet: ${goal.label}`;
      }
      if (/meeting.*(\d+)|(\d+).*meeting/i.test(spec)) {
        const n = parseInt(spec.match(/(\d+)/i)![1]);
        const goal = goalTracker.addGoal("meetings_max", period, n);
        return `GOALS\n\nSet: ${goal.label}`;
      }
      if (/lunch/i.test(spec)) {
        const goal = goalTracker.addGoal("lunch_protected", period, 1);
        return `GOALS\n\nSet: ${goal.label}`;
      }
    }

    // Show progress
    const progress = goalTracker.getProgress();
    if (progress.length === 0) {
      return `GOALS\n\nNo goals set yet. Try: "set goal: focus 2h daily"`;
    }
    const lines = progress.map((p) => {
      const bar = p.met ? "✓ Met" : `${p.percent}%`;
      const curr = p.goal.type === "focus_hours"
        ? `${p.current.toFixed(1)}h / ${p.goal.target}h`
        : p.goal.type === "lunch_protected"
        ? (p.current === 1 ? "protected" : "blocked")
        : `${p.current} / ${p.goal.target}`;
      return `${p.goal.label}: ${bar} (${curr})`;
    });
    return `GOALS PROGRESS\n\n${lines.join("\n")}`;
  }

  private async handleActionCommand(query: string): Promise<string> {
    const action = actionExecutor.parseActionFromQuery(query);
    if (!action) return "";

    const result = await actionExecutor.execute(action);
    if (result.success) {
      return `ACTION DONE\n\n${result.message}`;
    }
    return `ACTION FAILED\n\n${result.message}`;
  }

  private extractDuration(query: string): number {
    const m = query.match(/(\d+)\s*(hour|hr|h)\b/i);
    if (m) return parseInt(m[1]) * 60;
    const m2 = query.match(/(\d+)\s*(min|minute)/i);
    if (m2) return parseInt(m2[1]);
    // Default durations by context
    if (/focus|deep work/i.test(query)) return 90;
    return 60;
  }

  private extractTask(query: string): string | undefined {
    // "focus on X", "focus for Xm on X", "focus Xm on X"
    const patterns = [
      /focus(?:\s+(?:for\s+)?\d+\s*(?:min|hour|hr|h)\w*\s+)on\s+(.+)/i,
      /focus\s+on\s+(.+?)(?:\s+for\s+\d|\s*$)/i,
      /working on\s+(.+)/i,
      /task[:\s]+(.+)/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m) return m[1].trim();
    }
    return undefined;
  }

  private extractMeetingQuery(query: string): string {
    // Extract the meeting name/person from prep requests
    const patterns = [
      /prep(?:are)? for\s+(.+?)(?:\s+meeting)?$/i,
      /meeting\s+(?:with|about)\s+(.+)/i,
      /before\s+(?:my\s+)?(.+?)\s+meeting/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m) return m[1].trim();
    }
    // Fall back to full query
    return query;
  }

  private async handleFocusCommand(query: string): Promise<string> {
    const q = query.toLowerCase();

    if (/stop|end|finish/i.test(q)) {
      const session = await focusMode.stop();
      if (!session) return "FOCUS STATUS\n\nNo active focus session.";
      return `FOCUS SESSION ENDED\n\nWorked for ${session.actualMinutes} min${session.task ? ` on ${session.task}` : ""}.\n${session.completed ? "Completed as planned." : "Ended early."}`;
    }

    if (/extend/i.test(q)) {
      const minutes = this.extractDuration(query) || 30;
      const session = await focusMode.extend(minutes);
      if (!session) return "FOCUS STATUS\n\nNo active focus session to extend.";
      const endsAt = new Date(session.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `FOCUS EXTENDED\n\nSession now runs until ${endsAt}.`;
    }

    if (/stats/i.test(q)) {
      const stats = focusMode.getStats();
      return `FOCUS STATS\n\nThis week: ${stats.thisWeekMinutes}min\nTotal: ${stats.totalSessions} sessions, ${stats.totalMinutes}min\nAverage: ${stats.avgSessionLength}min\nCompletion: ${stats.completionRate}%\nBest day: ${stats.bestDay}`;
    }

    if (/status|active|running/i.test(q)) {
      const status = focusMode.getStatus();
      if (!status.active) return "FOCUS STATUS\n\nNo active session.";
      return `FOCUS STATUS\n\nActive: ${status.remainingMinutes}m ${status.remainingSeconds}s remaining${status.session?.task ? `\nTask: ${status.session.task}` : ""}`;
    }

    // Start focus
    const duration = this.extractDuration(query);
    const task = this.extractTask(query);
    const session = await focusMode.start(duration, task);
    const endsAt = new Date(session.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `FOCUS SESSION STARTED\n\nDuration: ${duration}min${task ? `\nTask: ${task}` : ""}\nEnds at: ${endsAt}\nDo Not Disturb: enabled`;
  }

  private async handleSchedulingQuery(query: string): Promise<string> {
    const q = query.toLowerCase();
    const duration = this.extractDuration(query);

    if (/focus block|deep work block/i.test(q)) {
      const suggestion = await smartScheduler.suggestFocusBlock(duration);
      return `SCHEDULING\n\n${smartScheduler.formatSuggestion(suggestion)}`;
    }

    // Check for conflict-checking ("can I do X at Y time")
    const timeMatch = query.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (timeMatch && /can i|is there|conflict/i.test(q)) {
      const today = new Date();
      const timeStr = timeMatch[1];
      const proposed = new Date(`${today.toDateString()} ${timeStr}`);
      if (!isNaN(proposed.getTime())) {
        const result = await smartScheduler.checkConflicts(proposed, duration);
        if (!result.hasConflict) {
          return `SCHEDULING\n\n${proposed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} looks clear for ${duration}min.`;
        }
        const conflictNames = result.conflicts.map((c) => c.title).join(", ");
        const alt = result.suggestion ? `\n\nAlternative: ${smartScheduler.formatSuggestion({ slots: [result.suggestion], recommendation: result.suggestion, reasoning: "", warnings: [] })}` : "";
        return `SCHEDULING\n\nConflict with: ${conflictNames}${alt}`;
      }
    }

    // General slot finding
    const days = /this week|5 day/i.test(q) ? 5 : /next week/i.test(q) ? 7 : 3;
    const suggestion = await smartScheduler.findFreeSlots(duration, days);
    return `SCHEDULING\n\n${smartScheduler.formatSuggestion(suggestion)}`;
  }

  private isDayRecapRequest(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes("recap") ||
      q.includes("how was my day") ||
      q.includes("how was today") ||
      q.includes("end of day") ||
      q.includes("wrap up") ||
      q.includes("how did today go") ||
      q.includes("day summary")
    );
  }

  private detectDateFromQuery(query: string): Date {
    const q = query.toLowerCase();
    const today = new Date();

    if (/yesterday/.test(q)) {
      const d = new Date(today); d.setDate(d.getDate() - 1); return d;
    }
    if (/day before yesterday/.test(q)) {
      const d = new Date(today); d.setDate(d.getDate() - 2); return d;
    }

    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (let i = 0; i < days.length; i++) {
      if (q.includes(days[i])) {
        const d = new Date(today);
        const diff = (today.getDay() - i + 7) % 7 || 7;
        d.setDate(d.getDate() - diff);
        return d;
      }
    }

    return today;
  }

  private extractAndRemember(query: string, _response: string) {
    const preferenceMatch = query.match(/I (prefer|like|always|usually) (.+)/i);
    if (preferenceMatch) {
      memory.remember("preference", preferenceMatch[2].slice(0, 50), query);
    }
    const personMatch = query.match(/(@\w+|[\w]+'s?) (is|works|prefers|likes)/i);
    if (personMatch) {
      memory.remember("person", personMatch[1], query.slice(0, 200));
    }
  }

  getStats() {
    return {
      router: this.router.getStats(),
      memory: memory.getStats(),
    };
  }

  clearHistory() {
    this.router.clearHistory();
  }
}

export const agent = new PersonalAgent();
