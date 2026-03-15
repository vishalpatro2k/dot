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
    this.systemPrompt = `You are a helpful personal assistant for a design lead. You help with:
- Managing calendar and meetings
- Tracking Slack messages and conversations  
- Organizing tasks and priorities
- Drafting communications
- Providing quick information and reminders

Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Be concise and helpful. For status queries, use bullet points. For drafts, match a professional but warm tone.`;
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
    additionalContext?: string
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

    // Keep last 10 messages for context
    const recentHistory = this.conversationHistory.slice(-10);

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
      slack?: string;
      tasks?: string;
      memory?: string;
    }
  ): Promise<RouterResponse> {
    const contextParts: string[] = [];

    if (context.calendar) {
      contextParts.push(`## Today's Calendar\n${context.calendar}`);
    }
    if (context.slack) {
      contextParts.push(`## Recent Slack Activity\n${context.slack}`);
    }
    if (context.tasks) {
      contextParts.push(`## Current Tasks\n${context.tasks}`);
    }
    if (context.memory) {
      contextParts.push(`## Relevant Memory\n${context.memory}`);
    }

    const additionalContext = contextParts.length > 0
      ? contextParts.join("\n\n")
      : undefined;

    return this.chat(userMessage, undefined, additionalContext);
  }
}

// Export singleton instance
export const router = new SmartRouter({ debug: true });
