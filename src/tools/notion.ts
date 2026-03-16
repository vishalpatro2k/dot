/**
 * Notion Calendar Integration
 *
 * Auto-discovers databases by inspecting page parents from the search API,
 * then queries each database for today's entries.
 *
 * Setup:
 * 1. Go to https://www.notion.so/my-integrations → open your integration
 * 2. Add NOTION_TOKEN to .env
 * 3. For each database: open in Notion → ... → Connections → add integration
 */

import { Client, isFullPage, LogLevel } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

// Format a date as YYYY-MM-DD in local timezone (not UTC)
function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface NotionEntry {
  id: string;
  title: string;
  database: string;
  date?: Date;
  endDate?: Date;
  durationHours?: number;
  status?: string;
  url: string;
}

export class NotionCalendarTool {
  private client: Client | null = null;
  // Map of database_id → database name
  private databases = new Map<string, string>();

  async init(): Promise<boolean> {
    const token = process.env.NOTION_TOKEN;

    if (!token) {
      console.log("⚠️  No NOTION_TOKEN found. Notion disabled.");
      return false;
    }

    this.client = new Client({ auth: token, logLevel: LogLevel.ERROR });

    try {
      // Discover databases by searching all pages and extracting their parent database IDs
      const response = await this.client.search({ page_size: 50 });

      const dbIds = new Set<string>();
      for (const result of response.results) {
        if (
          result.object === "page" &&
          "parent" in result &&
          (result.parent as any).database_id
        ) {
          dbIds.add((result.parent as any).database_id);
        }
      }

      if (dbIds.size === 0) {
        console.log("⚠️  No Notion databases found. Connect integration to your databases.");
        return false;
      }

      // Resolve database names
      await Promise.all(
        [...dbIds].map(async (id) => {
          try {
            const db = await this.client!.databases.retrieve({ database_id: id });
            const name = (db as any).title?.[0]?.plain_text || "Untitled";
            this.databases.set(id, name);
          } catch {
            this.databases.set(id, "Untitled");
          }
        })
      );

      const names = [...this.databases.values()].join(", ");
      console.log(`✓ Notion connected (${this.databases.size} databases: ${names})`);
      return true;
    } catch (error: any) {
      console.log(`⚠️  Notion connection failed: ${error.message}`);
      return false;
    }
  }

  async getEntriesForDate(date: Date): Promise<NotionEntry[]> {
    if (!this.client || this.databases.size === 0) return [];

    const dateStr = toLocalDateString(date);

    const results = await Promise.all(
      [...this.databases.entries()].map(([id, name]) =>
        this.queryDatabase(id, name, dateStr)
      )
    );

    return results
      .flat()
      .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  }

  async getTodaysEntries(): Promise<NotionEntry[]> {
    return this.getEntriesForDate(new Date());
  }

  private async queryDatabase(dbId: string, dbName: string, dateFilter?: string): Promise<NotionEntry[]> {
    if (!this.client) return [];
    try {
      const query: any = {
        database_id: dbId,
        page_size: 20,
        sorts: [{ property: "Date", direction: "ascending" }],
      };

      if (dateFilter) {
        query.filter = {
          property: "Date",
          date: { equals: dateFilter },
        };
      }

      const response = await this.client.databases.query(query);
      return response.results.filter(isFullPage).map((p) => this.parsePage(p, dbName));
    } catch {
      try {
        // Fallback: no filter, just recent
        const response = await this.client!.databases.query({
          database_id: dbId,
          page_size: 5,
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        });
        return response.results.filter(isFullPage).map((p) => this.parsePage(p, dbName));
      } catch {
        return [];
      }
    }
  }

  private parsePage(page: PageObjectResponse, dbName: string): NotionEntry {
    const props = page.properties;
    let title = "Untitled";
    let date: Date | undefined;
    let endDate: Date | undefined;
    let durationHours: number | undefined;
    let status: string | undefined;

    for (const [key, prop] of Object.entries(props)) {
      const k = key.toLowerCase();

      if (prop.type === "title" && prop.title.length > 0) {
        title = prop.title.map((t: any) => t.plain_text).join("");
      } else if (k === "date" && prop.type === "date" && prop.date) {
        date = new Date(prop.date.start);
        if (prop.date.end) endDate = new Date(prop.date.end);
      } else if (k === "status" && prop.type === "status" && prop.status) {
        status = prop.status.name;
      } else if (k === "status" && prop.type === "select" && prop.select) {
        status = prop.select.name;
      } else if (k.includes("duration") && prop.type === "formula" && prop.formula.type === "number") {
        durationHours = prop.formula.number ?? undefined;
      } else if (k.includes("duration") && prop.type === "number" && prop.number !== null) {
        durationHours = prop.number;
      }
    }

    return { id: page.id, title, database: dbName, date, endDate, durationHours, status, url: page.url };
  }

  getDatabaseIdByName(pattern: string): string | undefined {
    const p = pattern.toLowerCase();
    for (const [id, name] of this.databases) {
      if (name.toLowerCase().includes(p)) return id;
    }
    return undefined;
  }

  async createEntry(databaseId: string, entry: {
    title: string;
    start: Date;
    end?: Date;
  }): Promise<string | null> {
    if (!this.client) return null;
    try {
      const db = await this.client.databases.retrieve({ database_id: databaseId });
      const props = db.properties as Record<string, any>;

      const properties: Record<string, any> = {};

      // Title
      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === "title") {
          properties[name] = { title: [{ text: { content: entry.title } }] };
          break;
        }
      }

      // Date (start + optional end for duration formula)
      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === "date") {
          properties[name] = {
            date: {
              start: entry.start.toISOString(),
              ...(entry.end ? { end: entry.end.toISOString() } : {}),
            },
          };
          break;
        }
      }

      const page = await this.client.pages.create({
        parent: { database_id: databaseId },
        properties,
      });
      return page.id;
    } catch (err) {
      console.error("Notion createEntry failed:", err);
      return null;
    }
  }

  async updateEntryDate(pageId: string, start: Date, end: Date): Promise<void> {
    if (!this.client) return;
    try {
      const page = await this.client.pages.retrieve({ page_id: pageId }) as any;
      const dbId = page.parent?.database_id;
      if (!dbId) return;

      const db = await this.client.databases.retrieve({ database_id: dbId });
      const props = db.properties as Record<string, any>;

      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === "date") {
          await this.client.pages.update({
            page_id: pageId,
            properties: {
              [name]: { date: { start: start.toISOString(), end: end.toISOString() } },
            },
          });
          break;
        }
      }
    } catch (err: any) {
      // Silently skip archived pages or validation errors — best-effort update
      if (err?.code !== "validation_error") {
        console.error("Notion updateEntryDate failed:", err?.message ?? err);
      }
    }
  }

  async getContextString(date?: Date): Promise<string> {
    if (this.databases.size === 0) return "";
    const targetDate = date ?? new Date();
    const entries = await this.getEntriesForDate(targetDate);
    const dateLabel = this.formatDateLabel(targetDate);
    if (entries.length === 0) return `Notion Calendar connected. Nothing logged for ${dateLabel}.`;

    // Group by database
    const byDb = new Map<string, NotionEntry[]>();
    for (const e of entries) {
      if (!byDb.has(e.database)) byDb.set(e.database, []);
      byDb.get(e.database)!.push(e);
    }

    const sections = [...byDb.entries()].map(([db, items]) => {
      const lines = items.map((e) => {
        const start = e.date
          ? e.date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "";
        const end = e.endDate
          ? e.endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "";
        const time = start && end ? `${start}–${end}` : start;
        const dur = e.durationHours != null ? ` (${e.durationHours}h)` : "";
        const st = e.status ? ` [${e.status}]` : "";
        return `  • ${time ? time + ": " : ""}${e.title}${dur}${st}`;
      });
      return `${db}:\n${lines.join("\n")}`;
    });

    return `Notion log for ${dateLabel}:\n` + sections.join("\n\n");
  }

  private formatDateLabel(date: Date): string {
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "today";
    if (date.toDateString() === yesterday.toDateString()) return "yesterday";
    return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }
}

export const notion = new NotionCalendarTool();
