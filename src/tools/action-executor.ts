/**
 * Action Executor
 *
 * Executes real actions on behalf of the user: create calendar events,
 * create tasks, start focus sessions, and (when write scope is available)
 * decline meetings.
 *
 * Note: Google Calendar write operations (decline, create_event) require
 * the calendar write scope. Current auth only has readonly. These actions
 * will gracefully indicate when the scope is unavailable.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getAuthClient } from "./google-auth.js";
import { focusMode } from "./focus-mode.js";
import { notionTasks } from "./notion-tasks.js";

export type ActionType =
  | "decline_meeting"
  | "create_event"
  | "create_task"
  | "start_focus";

export interface ActionRequest {
  type: ActionType;
  // decline_meeting
  eventId?: string;
  eventTitle?: string;
  // create_event
  title?: string;
  startTime?: Date;
  endTime?: Date;
  description?: string;
  // create_task
  taskTitle?: string;
  taskDue?: string;
  // start_focus
  durationMinutes?: number;
  focusTask?: string;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export class ActionExecutor {
  async execute(action: ActionRequest): Promise<ActionResult> {
    switch (action.type) {
      case "decline_meeting":
        return this.declineMeeting(action);
      case "create_event":
        return this.createEvent(action);
      case "create_task":
        return this.createTask(action);
      case "start_focus":
        return this.startFocus(action);
      default:
        return { success: false, message: `Unknown action type` };
    }
  }

  private async declineMeeting(action: ActionRequest): Promise<ActionResult> {
    const auth = await getAuthClient();
    if (!auth) {
      return { success: false, message: "Google Calendar not authenticated" };
    }

    const cal = google.calendar({ version: "v3", auth: auth as OAuth2Client });

    if (!action.eventId) {
      return { success: false, message: "No event ID provided to decline" };
    }

    try {
      // Get own email first
      const oauth2 = google.oauth2({ version: "v2", auth: auth as OAuth2Client });
      const me = await oauth2.userinfo.get();
      const myEmail = me.data.email;

      if (!myEmail) {
        return { success: false, message: "Could not determine your email address" };
      }

      await cal.events.patch({
        calendarId: "primary",
        eventId: action.eventId,
        requestBody: {
          attendees: [{ email: myEmail, responseStatus: "declined" }],
        },
        sendUpdates: "all",
      });

      return {
        success: true,
        message: `Declined "${action.eventTitle || action.eventId}" and notified organizer`,
      };
    } catch (err: any) {
      if (err?.code === 403 || (err?.message || "").toLowerCase().includes("insufficient")) {
        return {
          success: false,
          message: "Calendar write permission not granted. Re-run `--auth-google` to add write scope.",
        };
      }
      return { success: false, message: `Failed to decline: ${err?.message}` };
    }
  }

  private async createEvent(action: ActionRequest): Promise<ActionResult> {
    const auth = await getAuthClient();
    if (!auth) {
      return { success: false, message: "Google Calendar not authenticated" };
    }

    if (!action.title || !action.startTime || !action.endTime) {
      return { success: false, message: "title, startTime, and endTime are required" };
    }

    const cal = google.calendar({ version: "v3", auth: auth as OAuth2Client });

    try {
      const event = await cal.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: action.title,
          description: action.description,
          start: { dateTime: action.startTime.toISOString() },
          end: { dateTime: action.endTime.toISOString() },
        },
      });

      const timeStr = action.startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return {
        success: true,
        message: `Created "${action.title}" at ${timeStr}`,
        data: { eventId: event.data.id },
      };
    } catch (err: any) {
      if (err?.code === 403 || (err?.message || "").toLowerCase().includes("insufficient")) {
        return {
          success: false,
          message: "Calendar write permission not granted. Re-run `--auth-google` to add write scope.",
        };
      }
      return { success: false, message: `Failed to create event: ${err?.message}` };
    }
  }

  private async createTask(action: ActionRequest): Promise<ActionResult> {
    if (!action.taskTitle) {
      return { success: false, message: "taskTitle is required" };
    }

    try {
      await notionTasks.addTask(action.taskTitle, { dueDate: action.taskDue });
      return {
        success: true,
        message: `Added: ${action.taskTitle}${action.taskDue ? ` (due ${action.taskDue})` : ""}`,
      };
    } catch (err: any) {
      return { success: false, message: `Failed to create task: ${err?.message}` };
    }
  }

  private async startFocus(action: ActionRequest): Promise<ActionResult> {
    try {
      const session = await focusMode.start(
        action.durationMinutes ?? 90,
        action.focusTask
      );
      const endsAt = new Date(session.endsAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      return {
        success: true,
        message: `Focus session started — ${action.durationMinutes ?? 90}min${action.focusTask ? ` on ${action.focusTask}` : ""}. Ends at ${endsAt}.`,
        data: { sessionId: session.id },
      };
    } catch (err: any) {
      return { success: false, message: `Could not start focus: ${err?.message}` };
    }
  }

  /**
   * Parse a natural-language action request from the agent query.
   * Returns null if no clear action is detected.
   */
  parseActionFromQuery(query: string): ActionRequest | null {
    const q = query.toLowerCase();

    // Decline meeting
    if (/decline|reject|skip.*meeting|can('t| not) make/i.test(q)) {
      const titleMatch = query.match(/decline[^"]*"([^"]+)"/i) ||
        query.match(/skip\s+(?:the\s+)?(.+?)\s+meeting/i);
      return {
        type: "decline_meeting",
        eventTitle: titleMatch?.[1],
      };
    }

    // Create task
    if (/add(?: a)? task|create(?: a)? task|remind me to|add to(?:do| my list)/i.test(q)) {
      const titleMatch = query.match(/(?:add|create)(?:\s+a)?\s+task[:\s]+(.+)/i) ||
        query.match(/remind me to\s+(.+)/i);
      return {
        type: "create_task",
        taskTitle: titleMatch?.[1]?.trim() ?? query,
      };
    }

    return null;
  }
}

export const actionExecutor = new ActionExecutor();
