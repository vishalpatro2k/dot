/**
 * Personal Agent
 * 
 * The main agent that combines:
 * - Smart LLM routing (Haiku vs Sonnet)
 * - Prompt caching for cost savings
 * - Calendar + Slack context
 * - Simple memory
 */

import { SmartRouter } from "./llm/router.js";
import { calendar } from "./tools/calendar.js";
import { notion } from "./tools/notion.js";
import { slack } from "./tools/slack.js";
import { memory } from "./memory/store.js";

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

  /**
   * Initialize all tools and connections
   */
  async init(): Promise<void> {
    console.log("\n🤖 Initializing Personal Agent...\n");
    
    // Initialize memory
    memory.init();
    
    // Try to connect calendar (non-blocking if no credentials)
    await calendar.init();

    // Try to connect Notion Calendar (non-blocking if no token)
    await notion.init();

    // Try to connect Slack (non-blocking if no token)
    await slack.init();
    
    this.initialized = true;
    console.log("\n✓ Agent ready!\n");
  }

  /**
   * Process a user query with full context
   */
  async ask(query: string): Promise<AgentResponse> {
    if (!this.initialized) {
      await this.init();
    }

    // Detect date references in the query
    const notionDate = this.detectDateFromQuery(query);

    // Gather context from all sources
    const [calendarContext, notionContext, slackContext] = await Promise.all([
      calendar.getContextString().catch(() => ""),
      notion.getContextString(notionDate).catch(() => ""),
      slack.getContextString().catch(() => "Slack unavailable"),
    ]);

    // Merge Google Calendar + Notion into one calendar context
    const combinedCalendar = [calendarContext, notionContext].filter(Boolean).join("\n\n") || "No calendar data.";

    const memoryContext = memory.getContextString();

    // Log the user query
    memory.logConversation("user", query);

    // Send to LLM with context
    const response = await this.router.chatWithContext(query, {
      calendar: combinedCalendar,
      slack: slackContext,
      memory: memoryContext || undefined,
    });

    // Log the response
    memory.logConversation("assistant", response.content, response.model, response.estimatedCost);

    // Extract any facts to remember (simple pattern matching)
    this.extractAndRemember(query, response.content);

    return {
      answer: response.content,
      model: response.model.includes("haiku") ? "Haiku" : "Sonnet",
      cost: response.estimatedCost,
      cached: response.cacheReadTokens > 0,
    };
  }

  /**
   * Get a morning briefing
   */
  async morningBrief(): Promise<AgentResponse> {
    return this.ask(
      "Give me a morning briefing. What's on my calendar today? Any important Slack messages I should know about? Keep it concise."
    );
  }

  /**
   * Quick status check
   */
  async status(): Promise<AgentResponse> {
    return this.ask("Quick status: What's my next meeting and any urgent unread messages?");
  }

  /**
   * Detect a date reference from a query (e.g. "yesterday", "Monday")
   */
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

  /**
   * Simple fact extraction to remember
   */
  private extractAndRemember(query: string, response: string) {
    // Remember if user mentions a preference
    const preferenceMatch = query.match(/I (prefer|like|always|usually) (.+)/i);
    if (preferenceMatch) {
      memory.remember("preference", preferenceMatch[2].slice(0, 50), query);
    }

    // Remember if mentioning a person
    const personMatch = query.match(/(@\w+|[\w]+'s?) (is|works|prefers|likes)/i);
    if (personMatch) {
      memory.remember("person", personMatch[1], query.slice(0, 200));
    }
  }

  /**
   * Get usage statistics
   */
  getStats() {
    return {
      router: this.router.getStats(),
      memory: memory.getStats(),
    };
  }

  /**
   * Clear conversation history (for new session)
   */
  clearHistory() {
    this.router.clearHistory();
  }
}

// Export singleton
export const agent = new PersonalAgent();
