/**
 * Conversation Manager
 *
 * Persists rolling conversation context (last 10 turns) so follow-up queries
 * like "tell me more", "do it", "the 3pm" resolve correctly.
 * Sessions expire after 30 minutes of inactivity.
 */

import { memory } from "../memory/store.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  context?: {
    meetingsMentioned?: string[];
    tasksMentioned?: string[];
    peopleMentioned?: string[];
  };
}

export interface Conversation {
  id: string;
  messages: ConversationMessage[];
  startedAt: string;
  lastActiveAt: string;
}

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 10;
const STORE_KEY = "conversation:active";

export class ConversationManager {
  private current: Conversation | null = null;

  getOrCreate(): Conversation {
    // Return in-memory if still warm
    if (this.current) {
      const elapsed = Date.now() - new Date(this.current.lastActiveAt).getTime();
      if (elapsed < TIMEOUT_MS) return this.current;
    }

    // Try persisted
    const saved = memory.getKV<Conversation>(STORE_KEY);
    if (saved) {
      const elapsed = Date.now() - new Date(saved.lastActiveAt).getTime();
      if (elapsed < TIMEOUT_MS) {
        this.current = saved;
        return saved;
      }
    }

    // Fresh conversation
    this.current = {
      id: `convo-${Date.now()}`,
      messages: [],
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    return this.current;
  }

  addMessage(role: "user" | "assistant", content: string, ctx?: ConversationMessage["context"]): void {
    const convo = this.getOrCreate();
    convo.messages.push({ role, content, timestamp: new Date().toISOString(), context: ctx });
    // Keep only last N
    if (convo.messages.length > MAX_MESSAGES) {
      convo.messages = convo.messages.slice(-MAX_MESSAGES);
    }
    convo.lastActiveAt = new Date().toISOString();
    this.current = convo;
    memory.saveKV(STORE_KEY, convo);
  }

  getContextMessages(): ConversationMessage[] {
    return this.getOrCreate().messages;
  }

  /** Returns a formatted context block to inject into the system prompt */
  buildContext(): string {
    const msgs = this.getContextMessages();
    if (msgs.length < 2) return "";

    const lines = ["CONVERSATION SO FAR:"];
    for (const m of msgs) {
      const who = m.role === "user" ? "User" : "Dot";
      const t = new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`[${t}] ${who}: ${m.content.slice(0, 220)}${m.content.length > 220 ? "…" : ""}`);
    }
    lines.push("\nUse this to resolve follow-ups: \"that\", \"do it\", \"tell me more\", \"the 3pm\", \"yes\", etc.");
    return lines.join("\n");
  }

  /** Returns the last N turns as LLM message objects for multi-turn prompting */
  getRecentTurns(n = 4): Array<{ role: "user" | "assistant"; content: string }> {
    return this.getContextMessages()
      .slice(-n)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  extractMentions(query: string, response: string): ConversationMessage["context"] {
    const ctx: ConversationMessage["context"] = {};
    const combined = `${query} ${response}`;

    const meetingRe = /(?:meeting|call|sync|review|standup)\s+(?:with\s+)?([A-Za-z]+)/gi;
    const meetings = [...combined.matchAll(meetingRe)].map((m) => m[1]);
    if (meetings.length) ctx.meetingsMentioned = [...new Set(meetings)];

    const peopleRe = /(?:with|from|to|@)\s+([A-Z][a-z]{2,})/g;
    const people = [...combined.matchAll(peopleRe)].map((m) => m[1]);
    if (people.length) ctx.peopleMentioned = [...new Set(people)];

    const taskRe = /(?:task|todo|remind|add)[:\s]+["']?([^"'\n]{4,50})["']?/gi;
    const tasks = [...combined.matchAll(taskRe)].map((m) => m[1]);
    if (tasks.length) ctx.tasksMentioned = tasks;

    return ctx;
  }

  clear(): void {
    this.current = null;
    memory.saveKV(STORE_KEY, null);
  }

  getLastUserMessage(): string | null {
    const msgs = this.getContextMessages().filter((m) => m.role === "user");
    return msgs[msgs.length - 1]?.content ?? null;
  }

  getLastAssistantMessage(): string | null {
    const msgs = this.getContextMessages().filter((m) => m.role === "assistant");
    return msgs[msgs.length - 1]?.content ?? null;
  }
}

export const conversationManager = new ConversationManager();
