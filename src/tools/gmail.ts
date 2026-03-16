/**
 * Gmail Integration with smart filtering
 *
 * Uses email-classifier.ts to surface only actionable emails
 * from a large inbox (70k+).
 */

import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getAuthClient } from "./google-auth.js";
import { classifyEmail, summarizeEmailStats, ClassifiedEmail } from "./email-classifier.js";

export class GmailTool {
  private gmail: gmail_v1.Gmail | null = null;
  private userEmail = "";

  async init(): Promise<boolean> {
    try {
      const auth = await getAuthClient();
      if (!auth) {
        console.log("⚠️  Gmail not authenticated. Run --auth-google.");
        return false;
      }
      this.gmail = google.gmail({ version: "v1", auth: auth as OAuth2Client });

      const profile = await this.gmail.users.getProfile({ userId: "me" });
      this.userEmail = profile.data.emailAddress || "";
      console.log(`✓ Gmail connected (${this.userEmail})`);
      return true;
    } catch (err) {
      console.error("Gmail init error:", err);
      return false;
    }
  }

  async getSmartInbox(limit = 50): Promise<{
    actionable: ClassifiedEmail[];
    ignored: { category: string; count: number }[];
    summary: string;
    totalUnread: number;
  }> {
    if (!this.gmail) {
      return { actionable: [], ignored: [], summary: "Gmail not connected", totalUnread: 0 };
    }

    try {
      // Estimate total unread
      const countRes = await this.gmail.users.messages.list({
        userId: "me",
        q: "is:unread is:inbox",
        maxResults: 1,
      });
      const totalUnread = countRes.data.resultSizeEstimate || 0;

      // Fetch recent unread
      const listRes = await this.gmail.users.messages.list({
        userId: "me",
        q: "is:unread is:inbox",
        maxResults: limit,
      });

      const emails: ClassifiedEmail[] = [];

      for (const msg of listRes.data.messages || []) {
        const detail = await this.gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = detail.data.payload?.headers || [];
        const get = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

        const fromHeader = get("From");
        const subject = get("Subject") || "(no subject)";
        const dateStr = get("Date");
        const labels = detail.data.labelIds || [];

        // Parse "Name <email>" or plain email
        const fromMatch = fromHeader.match(/^(?:"?([^"<]+)"?\s*)?<?([^>]+)>?$/);
        const fromName = fromMatch?.[1]?.trim() || fromMatch?.[2]?.split("@")[0] || "Unknown";
        const fromEmail = fromMatch?.[2]?.trim() || fromHeader;
        const domainMatch = fromEmail.match(/@([^>]+)/);
        const fromDomain = domainMatch ? domainMatch[1] : "";

        const classification = classifyEmail(
          fromEmail,
          fromName,
          subject,
          detail.data.snippet || "",
          labels
        );

        emails.push({
          id: msg.id!,
          threadId: msg.threadId!,
          from: fromEmail,
          fromName,
          fromDomain,
          subject,
          snippet: detail.data.snippet || "",
          date: dateStr ? new Date(dateStr) : new Date(parseInt(detail.data.internalDate || "0", 10)),
          ...classification,
        });
      }

      return { ...summarizeEmailStats(emails), totalUnread };
    } catch (err) {
      console.error("Gmail smart inbox error:", err);
      return { actionable: [], ignored: [], summary: "Error fetching emails", totalUnread: 0 };
    }
  }

  async getContextString(): Promise<string> {
    const { actionable, ignored, totalUnread } = await this.getSmartInbox(50);

    const lines: string[] = [];
    lines.push(`${totalUnread.toLocaleString()} unread total.`);

    if (actionable.length > 0) {
      lines.push("");
      lines.push("Needs attention:");

      const high = actionable.filter((e) => e.priority === "high");
      const medium = actionable.filter((e) => e.priority === "medium");

      for (const e of high) {
        const tag =
          e.category === "money" ? "[payment]" :
          e.category === "urgent" ? "[urgent]" :
          "[reply needed]";
        lines.push(`• ${e.fromName}: ${e.subject.slice(0, 50)}${e.subject.length > 50 ? "…" : ""} ${tag} (${timeAgo(e.date)})`);
      }

      for (const e of medium.slice(0, 5)) {
        lines.push(`• ${e.fromName}: ${e.subject.slice(0, 50)}${e.subject.length > 50 ? "…" : ""} (${timeAgo(e.date)})`);
      }
    } else {
      lines.push("No emails need your attention right now.");
    }

    if (ignored.length > 0) {
      lines.push("");
      lines.push("Filtered out:");
      const labels: Record<string, string> = {
        social: "Social notifications",
        newsletter: "Newsletters",
        promotion: "Promotions",
        receipt: "Receipts",
        automated: "Automated",
      };
      for (const { category, count } of ignored.slice(0, 5)) {
        lines.push(`• ${labels[category] ?? category}: ${count}`);
      }
    }

    return lines.join("\n");
  }

  // Legacy — kept for backwards compat with server.ts /emails/unread
  async getUnreadEmails(maxResults = 10): Promise<ClassifiedEmail[]> {
    const { actionable } = await this.getSmartInbox(maxResults);
    return actionable;
  }

  async getUnreadCount(): Promise<number> {
    if (!this.gmail) return 0;
    try {
      const res = await this.gmail.users.labels.get({ userId: "me", id: "INBOX" });
      return res.data.messagesUnread ?? 0;
    } catch {
      return 0;
    }
  }
}

function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const gmail = new GmailTool();
