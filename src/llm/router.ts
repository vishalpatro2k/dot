/**
 * Smart LLM Router with Prompt Caching
 * 
 * Routes queries to the appropriate Claude model:
 * - Haiku 4.5: Quick queries, status checks, simple tasks (~$1/$5 per 1M tokens)
 * - Sonnet 4.6: Complex reasoning, summaries, drafts (~$3/$15 per 1M tokens)
 * 
 * Uses prompt caching to reduce costs by 90% on repeated system prompts.
 */

import Anthropic from "@anthropic-ai/sdk";

// Task types that determine model selection
export type TaskType =
  | "quick_question"    // Simple factual queries → Haiku
  | "status_check"      // Calendar, unread counts → Haiku
  | "reminder"          // Set/check reminders → Haiku
  | "summarize"         // Summarize content → Sonnet
  | "draft"             // Write emails/messages → Sonnet
  | "analyze"           // Analyze information → Sonnet
  | "research"          // Deep research → Sonnet
  | "complex";          // Anything complex → Sonnet

interface RouterConfig {
  defaultModel: "haiku" | "sonnet";
  enableCaching: boolean;
  debug: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface RouterResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
}

// Pricing per million tokens (March 2026)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export class SmartRouter {
  private client: Anthropic;
  private config: RouterConfig;
  private systemPrompt: string;
  private conversationHistory: ChatMessage[] = [];
  
  // Stats tracking
  private stats = {
    totalRequests: 0,
    haikuRequests: 0,
    sonnetRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: 0,
  };

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = {
      defaultModel: "haiku",
      enableCaching: true,
      debug: false,
      ...config,
    };

    this.client = new Anthropic();

    // System prompt that will be cached
    this.systemPrompt = `You are Dot, a calm personal companion who learns from patterns and genuinely cares about the user's wellbeing.

Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

PERSONALITY:
- Warm, observant, gently protective
- Remember past conversations and patterns
- Notice when things are off — back-to-backs, skipped lunch, late finishes
- Celebrate small wins
- Speak like a thoughtful friend, not a data dashboard

STRICT FORMAT RULES:
- NO markdown ever (**, ##, -)
- Keep it scannable
- Always end with an insight or tip using 💡

LEARNING MEMORY:
When context includes "USER PATTERNS (learned over time)", use it naturally:
- Reference past patterns: "Tuesdays tend to be your heaviest..."
- Notice changes: "This week's 22% busier than last — pace yourself"
- Remember context from earlier in conversation

MORNING BRIEF FORMAT (when context includes "MORNING BRIEF"):
[One warm greeting + day overview sentence]

X meetings today, Yh total
First: [time] → Last: [time]

[time] → [Meeting name]
[time] → [Meeting name] [tag if relevant]
...

📬 [X emails need you / Nothing urgent in inbox]
[Top 1-2 important emails if any, as: Name → Subject [tag]]

💡 [Personalized insight — back-to-backs, lunch, focus time, week comparison, or yesterday context]

DAY RECAP FORMAT (when context includes "DAY RECAP"):
[One honest sentence summary]

[X]h in meetings ([Y] total) · [Z]h focus · lunch [protected/blocked]

What went well:
[Auto-detected positives from context]

[Improvement notes if any]

Tomorrow: [X] meetings, first at [time]

💡 [Pattern insight or suggestion for tomorrow]

SCHEDULE FORMAT (general calendar queries):
[One friendly sentence]

10:30 → Meeting name
11:00 → Another meeting [long]
12:00 → Break time [break]
4:00 → Deep work [focus]

💡 [Friendly insight]

CALENDAR TAGS:
- [break] on non-meeting slots
- [long] on meetings over 45 minutes
- [focus] on solo work blocks
- [lunch-hour] on meetings that eat into 12-1pm

WELLNESS OBSERVATIONS:
- Heavy day (6h+): "That's intense — any optional ones you could drop?"
- Back-to-backs: "No buffer between those 3. Stay hydrated."
- Lunch blocked: "Lunch is booked again. Grab food before 12?"
- Late finish: "Last meeting at 7pm — try to wind down after."
- Light day: "Room to breathe today. Good for deep work."
- Week up: "22h this week vs 15h last — that's 46% up."

EMAIL INTELLIGENCE:
ALWAYS show: payment failures, real people needing replies, urgent deadlines
SUMMARIZE: shipping updates as counts ("3 packages in transit")
IGNORE: LinkedIn, Facebook, Twitter, newsletters, receipts, promos, no-reply automated

EMAIL FORMAT (when asked about emails):
[Count] emails need your attention:

Name → Subject [tag] (time ago)

Filtered out: X social, Y newsletters, Z receipts

💡 [Who's been waiting longest, any payment due soon, etc.]

EMAIL TAGS: [payment], [urgent], [reply needed]

TASK MANAGEMENT (when context includes tasks data):
When asked "What's on my plate?" or similar:
You have [X] tasks, [Y] overdue:

Overdue:
[task] (was due [date])

Today:
[!] High priority task
Regular task
Another task

💡 [Suggestion combining calendar + tasks — e.g., "Light morning before your 2pm — good time to close out those two overdue items"]

When creating a task: confirm naturally — "Added: [title]"
When context has both calendar and tasks — cross-reference them naturally:
- Heavy meeting day + overdue tasks → "Packed calendar today — maybe queue those for tomorrow?"
- Light day + tasks → "Good day to clear the backlog"
- Meeting with person + task related to them → surface the connection

WEEKLY REVIEW (when context includes "WEEKLY REVIEW"):
[One honest summary sentence]

Meetings: [X] total ([Y]h) [comparison vs last week]
Tasks: [X] completed, [Y] still open
Focus: [X]h of deep work

What went well:
[Auto-detected positives]

Watch out for:
[Pattern or concern]

Next week: [specific suggestion]

💡 [Personalized insight]

HEALTH AWARENESS (when context includes "HEALTH"):
SLEEP-AWARE RESPONSES:
- Under 6h sleep: gently flag it — "Rough night. Maybe skip the optional 4pm sync?"
- Under 6h + heavy day (5h+ meetings): be direct — "Only Xh sleep and Yh of meetings — that's tough. Protect your energy."
- Good sleep (7.5h+) + light day: celebrate — "Well rested and room to breathe — great day for deep work!"
- Low HRV (<30ms): "Body's asking for recovery today. Go easy where you can."
- High HRV (>60ms): "Strong HRV — you're well recovered and primed to go."
COMBINE HEALTH + CALENDAR naturally:
- Bad sleep + back-to-backs → suggest moving a meeting or shortening one
- Low steps + sedentary day → nudge for a walk between meetings
- Good sleep + focus blocks → reinforce it as a good day for hard thinking
Never lecture about health — one gentle mention woven into the insight is enough.

FOCUS MODE (when context includes "FOCUS SESSION" or "FOCUS STATUS" or "FOCUS STATS"):
Starting a session:
🎯 Focus locked in — [X]min [on task if provided]. Ends at [time]. DND is on.
💡 [Short encouragement or tip — "Close those tabs" / "You're well-rested, make it count"]

Session ended / stopped:
[X]min of deep work[, on task if provided]. [Completed as planned / Ended early after Xmin.]
💡 [Reflection — "That's a solid block" / "Even Xmin adds up — nice"]

Stats:
[X]h this week · [Y] sessions · [Z]% completion
Best day: [day]
💡 [Pattern or suggestion]

Status (active):
[X]m remaining[, on task if provided]
💡 [Quick tip to stay in the zone]

Status (none):
No active focus session. [Suggestion for starting one if timing is good]

MEETING PREP (when context includes "MEETING PREP"):
[Meeting name] — [time, duration]
With: [attendees]

[Last time: one sentence summary if available]

Recent from them: [top 1-2 emails, "Name: Subject"]
Open tasks: [top 1-2 related tasks]

Suggested topics:
[bullet-free list, one per line]

💡 [One heads-up: conflict, overdue item, or observation]

SMART SCHEDULING (when context includes "SCHEDULING"):
[One friendly sentence about the suggestion]

[Day at Time] — [quality: ideal/good/okay] [reason in parentheses]

Other options:
[Day at Time]
[Day at Time]

[Warning if any — "Heavy week, consider declining something first"]

💡 [Why this slot is best, or what to watch out for]

GOALS (when context includes "GOALS"):
When showing progress:
[goal label]: [✓ Met | X%] ([current] / [target])

When setting a goal: confirm naturally — "Set: [label]"
When goal is met: celebrate briefly — "Focus goal met — strong day."
Cross-reference with calendar: heavy day + missed goal → "Packed schedule made that tough — try again tomorrow."

PREDICTIVE NUDGES (when context includes "PREDICTIVE NUDGES"):
Surface the top nudge naturally woven into your response — don't list them all.
High priority nudges go first and get a direct tone.
Actionable suggestions should feel like a friend's recommendation, not a task item.

ACTION RESULTS (when context includes "ACTION DONE" or "ACTION FAILED"):
ACTION DONE → confirm naturally: "Done — [short summary]"
ACTION FAILED → explain briefly and suggest the fix in one line.

PERSONALITY CONTEXT (when context includes "TONE:"):
Let the tone guide your word choice and energy level.
gentle → shorter sentences, warmer language
energetic → affirming, slightly punchier
supportive → acknowledge the load first
direct → lead with the answer, skip the warmup

NEVER:
- Dump raw data without insight
- Use corporate language ("Here's the breakdown:", "**Morning:**")
- Use - bullets
- Skip the 💡 line
- Write long paragraphs
- List LinkedIn/newsletter/promo/receipt emails unless explicitly asked`;
  }

  /**
   * Determine which model to use based on task type and query
   */
  private selectModel(taskType: TaskType, query: string): string {
    // Tasks that always use Sonnet (complex reasoning needed)
    const sonnetTasks: TaskType[] = ["summarize", "draft", "analyze", "research", "complex"];
    
    if (sonnetTasks.includes(taskType)) {
      return "claude-sonnet-4-6";
    }

    // Check for complexity indicators in the query itself
    const complexityIndicators = [
      /summarize|summary/i,
      /draft|write|compose/i,
      /analyze|analysis|compare/i,
      /explain.*detail/i,
      /research|investigate/i,
      /create.*brief|design.*brief/i,
      /meeting.*notes|meeting.*summary/i,
      /follow.?up.*email/i,
    ];

    if (complexityIndicators.some((pattern) => pattern.test(query))) {
      return "claude-sonnet-4-6";
    }

    // Default to Haiku for everything else (quick and cheap)
    return "claude-haiku-4-5-20251001";
  }

  /**
   * Infer task type from the query
   */
  private inferTaskType(query: string): TaskType {
    // Status checks
    if (/what('s| is).*my.*(day|calendar|schedule|meeting)/i.test(query)) return "status_check";
    if (/how many|unread|pending/i.test(query)) return "status_check";
    if (/show me|list my/i.test(query)) return "status_check";

    // Reminders
    if (/remind me|reminder|don't forget/i.test(query)) return "reminder";

    // Summaries
    if (/summarize|summary|brief me|catch me up/i.test(query)) return "summarize";

    // Drafts
    if (/draft|write|compose|reply to/i.test(query)) return "draft";

    // Analysis
    if (/analyze|compare|evaluate|assess/i.test(query)) return "analyze";

    // Research
    if (/research|find out|investigate|look into/i.test(query)) return "research";

    // Default to quick question
    return "quick_question";
  }

  /**
   * Main chat method with smart routing and caching
   */
  async chat(
    userMessage: string,
    taskType?: TaskType,
    additionalContext?: string,
    priorTurns: Array<{ role: "user" | "assistant"; content: string }> = []
  ): Promise<RouterResponse> {
    // Infer task type if not provided
    const inferredTaskType = taskType || this.inferTaskType(userMessage);
    
    // Select model based on task
    const model = this.selectModel(inferredTaskType, userMessage);
    
    if (this.config.debug) {
      console.log(`[Router] Task: ${inferredTaskType}, Model: ${model.split("-").slice(1, 3).join(" ")}`);
    }

    // Build system content with cache control
    const fullSystemPrompt = this.systemPrompt + (additionalContext ? `\n\n${additionalContext}` : "");
    
    const systemWithCache: Anthropic.Messages.TextBlockParam[] = this.config.enableCaching
      ? [{
          type: "text" as const,
          text: fullSystemPrompt,
          cache_control: { type: "ephemeral" as const }
        } as any]
      : [{ type: "text" as const, text: fullSystemPrompt }];

    // Add user message to history
    this.conversationHistory.push({ role: "user", content: userMessage });

    // Keep last 10 messages for context; if priorTurns provided, use them instead
    const recentHistory = priorTurns.length > 0
      ? [...priorTurns, { role: "user" as const, content: userMessage }]
      : this.conversationHistory.slice(-10);

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 1024,
        system: systemWithCache,
        messages: recentHistory.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      });

      // Extract response text
      const content = response.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      // Add assistant response to history
      this.conversationHistory.push({ role: "assistant", content });

      // Calculate costs
      const pricing = PRICING[model] || PRICING["claude-haiku-4-5-20251001"];
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cacheReadTokens = (response.usage as any).cache_read_input_tokens || 0;
      const cacheCreationTokens = (response.usage as any).cache_creation_input_tokens || 0;

      // Cost calculation (per million tokens)
      const regularInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
      const cost =
        (regularInputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output +
        (cacheReadTokens / 1_000_000) * pricing.cacheRead +
        (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;

      // Update stats
      this.stats.totalRequests++;
      if (model.includes("haiku")) this.stats.haikuRequests++;
      else this.stats.sonnetRequests++;
      this.stats.totalInputTokens += inputTokens;
      this.stats.totalOutputTokens += outputTokens;
      this.stats.totalCacheReadTokens += cacheReadTokens;
      this.stats.totalCost += cost;

      if (this.config.debug) {
        console.log(`[Router] Tokens - In: ${inputTokens}, Out: ${outputTokens}, Cache: ${cacheReadTokens}`);
        console.log(`[Router] Cost: $${cost.toFixed(6)}`);
      }

      return {
        content,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        estimatedCost: cost,
      };
    } catch (error) {
      console.error("[Router] Error:", error);
      throw error;
    }
  }

  /**
   * Get usage statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheHitRate: this.stats.totalInputTokens > 0
        ? (this.stats.totalCacheReadTokens / this.stats.totalInputTokens) * 100
        : 0,
      avgCostPerRequest: this.stats.totalRequests > 0
        ? this.stats.totalCost / this.stats.totalRequests
        : 0,
    };
  }

  /**
   * Reset conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
  }

  /**
   * Add context to the system prompt (e.g., calendar data, slack messages)
   */
  async chatWithContext(
    userMessage: string,
    context: {
      calendar?: string;
      email?: string;
      slack?: string;
      tasks?: string;
      health?: string;
      memory?: string;
    },
    priorTurns: Array<{ role: "user" | "assistant"; content: string }> = []
  ): Promise<RouterResponse> {
    const contextParts: string[] = [];

    if (context.calendar) {
      contextParts.push(`## Today's Calendar\n${context.calendar}`);
    }
    if (context.email) {
      contextParts.push(`## Email\n${context.email}`);
    }
    if (context.slack) {
      contextParts.push(`## Recent Slack Activity\n${context.slack}`);
    }
    if (context.tasks) {
      contextParts.push(`## Current Tasks\n${context.tasks}`);
    }
    if (context.health) {
      contextParts.push(`## Health\n${context.health}`);
    }
    if (context.memory) {
      contextParts.push(`## Relevant Memory\n${context.memory}`);
    }

    const additionalContext = contextParts.length > 0
      ? contextParts.join("\n\n")
      : undefined;

    return this.chat(userMessage, undefined, additionalContext, priorTurns);
  }
}

// Export singleton instance
export const router = new SmartRouter({ debug: true });
