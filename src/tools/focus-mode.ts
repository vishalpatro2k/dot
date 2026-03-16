/**
 * Focus Mode
 *
 * Tracks deep-work sessions with optional macOS DND integration.
 * Sessions persist in SQLite kv_store for stats and patterns.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import { memory } from "../memory/store.js";
import { notion } from "./notion.js";

const execAsync = promisify(exec);

export interface FocusSession {
  id: string;
  startedAt: string; // ISO string for JSON-safe storage
  endsAt: string;
  duration: number; // minutes originally planned
  task?: string;
  completed: boolean;
  interrupted: boolean;
  actualMinutes?: number;
  notionPageId?: string;
}

export interface FocusStatus {
  active: boolean;
  session: FocusSession | null;
  remainingMinutes: number;
  remainingSeconds: number;
}

export interface FocusStats {
  totalSessions: number;
  totalMinutes: number;
  avgSessionLength: number;
  completionRate: number;
  bestDay: string;
  thisWeekMinutes: number;
}

export class FocusMode extends EventEmitter {
  private activeSession: FocusSession | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  async start(minutes: number, task?: string): Promise<FocusSession> {
    if (this.activeSession) throw new Error("Focus session already active");

    const now = new Date();
    const endsAt = new Date(now.getTime() + minutes * 60_000);

    this.activeSession = {
      id: `focus-${now.getTime()}`,
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      duration: minutes,
      task,
      completed: false,
      interrupted: false,
    };

    this.saveSession(this.activeSession);
    await this.enableDND();

    // Log to office database in Notion (awaited so CLI doesn't exit before write completes)
    try { await this.logFocusToNotion(this.activeSession); } catch { /* best-effort */ }

    this.endTimer = setTimeout(() => this.complete(), minutes * 60_000);
    this.tickTimer = setInterval(() => this.emit("tick", this.getStatus()), 60_000);

    this.emit("start", this.activeSession);
    return this.activeSession;
  }

  async stop(): Promise<FocusSession | null> {
    if (!this.activeSession) return null;

    const session = { ...this.activeSession };
    session.interrupted = true;
    session.completed = false;
    session.actualMinutes = Math.round(
      (Date.now() - new Date(session.startedAt).getTime()) / 60_000
    );

    this.clearTimers();
    await this.disableDND();
    this.saveSession(session);
    this.activeSession = null;

    // Update Notion entry with actual end time (best-effort)
    if (session.notionPageId) {
      notion.updateEntryDate(
        session.notionPageId,
        new Date(session.startedAt),
        new Date()
      ).catch(() => {});
    }

    this.emit("stop", session);
    return session;
  }

  private async complete(): Promise<void> {
    if (!this.activeSession) return;

    const session = { ...this.activeSession };
    session.completed = true;
    session.actualMinutes = session.duration;

    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.endTimer = null;

    await this.disableDND();
    this.saveSession(session);
    this.activeSession = null;

    // Update Notion entry with actual end time (best-effort)
    if (session.notionPageId) {
      notion.updateEntryDate(
        session.notionPageId,
        new Date(session.startedAt),
        new Date()
      ).catch(() => {});
    }

    this.emit("complete", session);
  }

  async extend(minutes: number): Promise<FocusSession | null> {
    if (!this.activeSession) return null;
    if (this.endTimer) clearTimeout(this.endTimer);

    const newEnd = new Date(
      new Date(this.activeSession.endsAt).getTime() + minutes * 60_000
    );
    this.activeSession.endsAt = newEnd.toISOString();
    this.activeSession.duration += minutes;

    const remaining = newEnd.getTime() - Date.now();
    this.endTimer = setTimeout(() => this.complete(), remaining);

    this.emit("extend", this.activeSession);
    return this.activeSession;
  }

  getStatus(): FocusStatus {
    if (!this.activeSession) {
      return { active: false, session: null, remainingMinutes: 0, remainingSeconds: 0 };
    }
    const remaining = Math.max(0, new Date(this.activeSession.endsAt).getTime() - Date.now());
    return {
      active: true,
      session: this.activeSession,
      remainingMinutes: Math.floor(remaining / 60_000),
      remainingSeconds: Math.floor((remaining % 60_000) / 1000),
    };
  }

  getStats(): FocusStats {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const sessions: FocusSession[] = [];

    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `focus:daily:${d.toISOString().split("T")[0]}`;
      const daily = memory.getKV<{ sessions: string[] }>(key);
      if (daily?.sessions) {
        for (const id of daily.sessions) {
          const s = memory.getKV<FocusSession>(`focus:session:${id}`);
          if (s) sessions.push(s);
        }
      }
    }

    const completed = sessions.filter((s) => s.completed);
    const thisWeek = sessions.filter(
      (s) => new Date(s.startedAt) >= weekAgo && s.completed
    );

    const totalMinutes = completed.reduce(
      (sum, s) => sum + (s.actualMinutes ?? s.duration),
      0
    );
    const thisWeekMinutes = thisWeek.reduce(
      (sum, s) => sum + (s.actualMinutes ?? s.duration),
      0
    );

    const dayMinutes: Record<string, number> = {};
    for (const s of completed) {
      const day = new Date(s.startedAt).toLocaleDateString("en-US", { weekday: "long" });
      dayMinutes[day] = (dayMinutes[day] || 0) + (s.actualMinutes ?? s.duration);
    }
    const bestDay =
      Object.entries(dayMinutes).sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";

    return {
      totalSessions: sessions.length,
      totalMinutes,
      avgSessionLength: completed.length > 0 ? Math.round(totalMinutes / completed.length) : 0,
      completionRate:
        sessions.length > 0 ? Math.round((completed.length / sessions.length) * 100) : 0,
      bestDay,
      thisWeekMinutes,
    };
  }

  getTodaysFocusMinutes(): number {
    const key = `focus:daily:${new Date().toISOString().split("T")[0]}`;
    const daily = memory.getKV<{ totalMinutes: number }>(key);
    return daily?.totalMinutes ?? 0;
  }

  /**
   * Maps a focus task to the best Notion database name.
   * Returns null if no database match is found.
   */
  private detectNotionDatabase(task?: string): string | null {
    if (!task) return "office";

    const t = task.toLowerCase();

    // Family — check early since "home" is shared with chores
    if (/\b(fam|family|mom|dad|mum|papa|mama|brother|sister|sibling|parent|grandma|grandpa|cousin|uncle|aunt|relatives?|w fam)\b/.test(t)) {
      return "w fam";
    }

    // Travel — check before reading so "book flight" goes here not reading
    if (/\b(travel|trip|flight|flights|hotel|itinerary|packing|airport|journey|vacation|holiday)\b/.test(t)) {
      return "travel";
    }

    // Home chores — check before running so "grocery run" goes here
    if (/\b(chore|chores|clean|cleaning|laundry|dishes|cook|cooking|groceries|grocery|vacuum|tidy|organise|organize|declutter|repair|home chores)\b/.test(t)) {
      return "home chores";
    }

    // Running / gym / fitness
    if (/\b(running|gym|workout|exercise|lifting|swimming|cycling|yoga|stretching|hiit|crossfit|cardio|jogging|hiking|training|tennis|basketball|football|cricket|badminton|squash)\b/.test(t) ||
        /\b(morning|evening|daily|5k|10k)\s+run\b/.test(t) ||
        /\brun\b(?!\s*(errands|to|the|a\s))/.test(t)) {
      return "running/gym";
    }

    // Personal — accounts, finance, life admin
    if (/\b(personal|account|payment|bills?|bank|finance|tax(?:es)?|insurance|documents?|admin|budget|subscriptions?|rent|invest|savings?|loan|medical|dental|doctor|appointment|apply|application)\b/.test(t)) {
      return "personal";
    }

    // Reading — use "books" plural or "reading/read" to avoid "book a flight"
    if (/\b(reading|books|article|articles|journal|novel|blog|newsletter|chapter)\b/.test(t) ||
        /\bread\b/.test(t)) {
      return "reading";
    }

    // DJ / music production
    if (/\b(dj|djing|mix|mixing|produce|producing|track|beat|ableton|serato|playlist|set)\b/.test(t)) {
      return "dj";
    }

    // Entertainment / media
    if (/\b(netflix|youtube|prime|series|movie|film|show|episode|watch|watching|anime)\b/.test(t)) {
      return "netflix/prime/youtube";
    }

    // Social / instagram
    if (/\b(instagram|insta|social media|post|content|reel|story|tiktok|twitter|linkedin post)\b/.test(t)) {
      return "instagram";
    }

    // Freelance
    if (/\b(freelance|client work|contract|invoice|freelancing)\b/.test(t)) {
      return "freelance";
    }

    // Building / creating → studio
    if (/\b(build|building|built|code|coding|dev|develop|implement|feature|bug|fix|refactor|debug|test|script|automat|prototype|wireframe|ui|ux|front.?end|back.?end|api|component|deploy|ship|launch|hack|side.?project|app|website|plugin|tool|library|package|specs?|mock.?up)\b/.test(t)) {
      return "studio";
    }

    // Creative / design craft → studio
    if (/\b(design system|design review|brand|logo|illustration|motion|animation|figma|sketch|framer)\b/.test(t)) {
      return "studio";
    }

    // Everything else → office
    return "office";
  }

  private async logFocusToNotion(session: FocusSession): Promise<void> {
    const dbName = this.detectNotionDatabase(session.task);
    if (!dbName) return; // personal task — don't log
    const dbId = notion.getDatabaseIdByName(dbName);
    if (!dbId) return;

    const title = session.task ?? "Focus Session";
    const start = new Date(session.startedAt);
    const end = new Date(session.endsAt);

    const pageId = await notion.createEntry(dbId, { title, start, end });
    if (pageId) {
      session.notionPageId = pageId;
      this.saveSession(session);
      if (this.activeSession) this.activeSession.notionPageId = pageId;
    }
  }

  private saveSession(session: FocusSession): void {
    memory.saveKV(`focus:session:${session.id}`, session);

    const today = new Date(session.startedAt).toISOString().split("T")[0];
    const dailyKey = `focus:daily:${today}`;
    const daily = memory.getKV<{ sessions: string[]; totalMinutes: number }>(dailyKey) ?? {
      sessions: [],
      totalMinutes: 0,
    };

    if (!daily.sessions.includes(session.id)) daily.sessions.push(session.id);

    // Recompute total from all stored sessions for this day
    let total = 0;
    for (const id of daily.sessions) {
      const s = memory.getKV<FocusSession>(`focus:session:${id}`);
      if (s?.completed || s?.actualMinutes) {
        total += s.actualMinutes ?? s.duration;
      }
    }
    daily.totalMinutes = total;
    memory.saveKV(dailyKey, daily);
  }

  private clearTimers(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.endTimer = null;
    this.tickTimer = null;
  }

  private async enableDND(): Promise<void> {
    try {
      await Promise.race([
        execAsync(`shortcuts run "Enable Do Not Disturb" 2>/dev/null`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
    } catch {
      // DND is best-effort — no-op if not configured or timed out
    }
  }

  private async disableDND(): Promise<void> {
    try {
      await Promise.race([
        execAsync(`shortcuts run "Disable Do Not Disturb" 2>/dev/null`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
    } catch {
      // Best-effort
    }
  }
}

export const focusMode = new FocusMode();
