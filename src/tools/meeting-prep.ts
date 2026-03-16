/**
 * Meeting Prep
 *
 * Gathers context for an upcoming meeting: previous meetings,
 * recent emails from attendees, related tasks, and suggested topics.
 */

import { calendar, CalendarEvent } from "./calendar.js";
import { gmail } from "./gmail.js";
import { notionTasks } from "./notion-tasks.js";
import { memory } from "../memory/store.js";

export interface MeetingContext {
  meeting: CalendarEvent;
  previousMeetings: PreviousMeeting[];
  relevantEmails: RelevantEmail[];
  relatedTasks: RelatedTask[];
  suggestedTopics: string[];
  lastMeetingNotes?: string;
}

export interface PreviousMeeting {
  date: string;
  title: string;
  duration: number;
  summary?: string;
}

export interface RelevantEmail {
  from: string;
  subject: string;
  date: string;
}

export interface RelatedTask {
  title: string;
  status: string;
  dueDate?: string;
}

export class MeetingPrepTool {
  async prepareForMeeting(meetingQuery: string): Promise<MeetingContext | null> {
    const meeting = await this.findMeeting(meetingQuery);
    if (!meeting) return null;

    const [previousMeetings, relevantEmails, relatedTasks, lastNotes] = await Promise.all([
      this.getPreviousMeetings(meeting.title),
      this.getRelevantEmails(meeting.attendees),
      this.getRelatedTasks(meeting.title, meeting.attendees),
      Promise.resolve(this.getLastMeetingNotes(meeting.title)),
    ]);

    const suggestedTopics = this.generateSuggestedTopics(
      previousMeetings,
      relevantEmails,
      relatedTasks
    );

    return { meeting, previousMeetings, relevantEmails, relatedTasks, suggestedTopics, lastMeetingNotes: lastNotes };
  }

  private async findMeeting(query: string): Promise<CalendarEvent | null> {
    const upcoming = await calendar.getUpcomingEvents(48);
    const q = query.toLowerCase();

    return (
      upcoming.find((e) => e.title.toLowerCase().includes(q)) ||
      upcoming.find((e) => e.attendees.some((a) => a.toLowerCase().includes(q))) ||
      upcoming.find((e) =>
        q.split(/\s+/).filter((w) => w.length > 3).some((w) => e.title.toLowerCase().includes(w))
      ) ||
      null
    );
  }

  private async getPreviousMeetings(title: string): Promise<PreviousMeeting[]> {
    const history = memory.getKV<PreviousMeeting[]>("meetings:history") ?? [];
    const titleWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return history
      .filter((m) => titleWords.some((w) => m.title.toLowerCase().includes(w)))
      .slice(0, 5);
  }

  private async getRelevantEmails(attendees: string[]): Promise<RelevantEmail[]> {
    try {
      const { actionable } = await gmail.getSmartInbox(50);
      return actionable
        .filter((e) =>
          attendees.some(
            (a) =>
              e.fromName.toLowerCase().includes(a.toLowerCase()) ||
              a.toLowerCase().includes(e.fromName.toLowerCase())
          )
        )
        .slice(0, 5)
        .map((e) => ({
          from: e.fromName,
          subject: e.subject,
          date: e.date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        }));
    } catch {
      return [];
    }
  }

  private async getRelatedTasks(title: string, attendees: string[]): Promise<RelatedTask[]> {
    try {
      const allTasks = await notionTasks.getTodaysTasks();
      const titleWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const attendeeLower = attendees.map((a) => a.toLowerCase());

      return allTasks
        .filter((t) => {
          const tl = t.title.toLowerCase();
          return (
            titleWords.some((w) => tl.includes(w)) ||
            attendeeLower.some((a) => tl.includes(a))
          );
        })
        .slice(0, 5)
        .map((t) => ({ title: t.title, status: t.status, dueDate: t.dueDate }));
    } catch {
      return [];
    }
  }

  private getLastMeetingNotes(title: string): string | undefined {
    const key = `meeting:notes:${title.toLowerCase().replace(/\s+/g, "_")}`;
    const notes = memory.getKV<{ summary: string }>(key);
    return notes?.summary;
  }

  private generateSuggestedTopics(
    previousMeetings: PreviousMeeting[],
    emails: RelevantEmail[],
    tasks: RelatedTask[]
  ): string[] {
    const topics: string[] = [];
    if (previousMeetings[0]?.summary) topics.push(`Follow up: ${previousMeetings[0].summary.slice(0, 50)}`);
    if (emails[0]) topics.push(`Discuss: ${emails[0].subject}`);
    const pending = tasks.filter((t) => t.status !== "done");
    if (pending[0]) topics.push(`Review: ${pending[0].title}`);
    const overdue = tasks.filter((t) => t.dueDate && new Date(t.dueDate) < new Date());
    if (overdue[0]) topics.push(`Overdue: ${overdue[0].title}`);
    return topics.slice(0, 4);
  }

  saveMeetingNotes(meetingTitle: string, summary: string, actionItems: string[] = []): void {
    const key = `meeting:notes:${meetingTitle.toLowerCase().replace(/\s+/g, "_")}`;
    memory.saveKV(key, { summary, actionItems, savedAt: new Date().toISOString() });

    const historyKey = "meetings:history";
    const history = memory.getKV<PreviousMeeting[]>(historyKey) ?? [];
    history.unshift({
      date: new Date().toISOString(),
      title: meetingTitle,
      duration: 0,
      summary: summary.slice(0, 100),
    });
    memory.saveKV(historyKey, history.slice(0, 50));
  }

  formatPrepContext(ctx: MeetingContext): string {
    const lines: string[] = [];
    const t = ctx.meeting.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    lines.push(`MEETING PREP: ${ctx.meeting.title}`);
    lines.push(`Time: ${t} | Duration: ${ctx.meeting.duration} min`);
    if (ctx.meeting.attendees.length > 0) lines.push(`With: ${ctx.meeting.attendees.join(", ")}`);
    if (ctx.meeting.meetLink) lines.push(`Link: ${ctx.meeting.meetLink}`);

    if (ctx.previousMeetings.length > 0) {
      lines.push("\nPrevious meetings:");
      ctx.previousMeetings.slice(0, 3).forEach((m) => {
        lines.push(`  ${new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${m.title}${m.summary ? ` — ${m.summary}` : ""}`);
      });
    }

    if (ctx.relevantEmails.length > 0) {
      lines.push("\nRecent emails from attendees:");
      ctx.relevantEmails.forEach((e) => lines.push(`  ${e.from}: ${e.subject} (${e.date})`));
    }

    if (ctx.relatedTasks.length > 0) {
      lines.push("\nRelated tasks:");
      ctx.relatedTasks.forEach((t) => {
        const check = t.status === "done" ? "✓" : "○";
        lines.push(`  ${check} ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}`);
      });
    }

    if (ctx.suggestedTopics.length > 0) {
      lines.push("\nSuggested topics:");
      ctx.suggestedTopics.forEach((t) => lines.push(`  • ${t}`));
    }

    if (ctx.lastMeetingNotes) lines.push(`\nLast time: ${ctx.lastMeetingNotes}`);

    return lines.join("\n");
  }
}

export const meetingPrep = new MeetingPrepTool();
