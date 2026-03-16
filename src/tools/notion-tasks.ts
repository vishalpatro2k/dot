/**
 * Notion Tasks Integration
 *
 * Auto-discovers database structure and maps status/priority/date properties.
 * Setup: npm run cli -- --setup-tasks <database-id>
 */

import { Client, LogLevel } from "@notionhq/client";
import { memory } from "../memory/store.js";

export interface Task {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  priority?: "high" | "medium" | "low";
  dueDate?: string;
  project?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TasksConfig {
  databaseId: string;
  titleProperty: string;
  statusProperty: string;
  statusType: "status" | "select";
  statusMapping: {
    todo: string[];
    in_progress: string[];
    done: string[];
  };
  dueDateProperty?: string;
  priorityProperty?: string;
  projectProperty?: string;
}

export class NotionTasksTool {
  private client: Client;
  private config: TasksConfig | null = null;

  constructor() {
    this.client = new Client({ auth: process.env.NOTION_TOKEN, logLevel: LogLevel.ERROR });
  }

  async init(databaseId?: string): Promise<boolean> {
    const savedConfig = memory.getKV<TasksConfig>("notion:tasks_config");

    if (savedConfig) {
      this.config = savedConfig;
      console.log("✓ Notion Tasks connected (cached config)");
      return true;
    }

    if (!databaseId) {
      console.log("⚠️  No Notion tasks database configured.");
      console.log("    Run: npm run cli -- --setup-tasks <database-id>");
      return false;
    }

    return this.discoverAndSave(databaseId);
  }

  async discoverAndSave(databaseId: string): Promise<boolean> {
    try {
      const database = await this.client.databases.retrieve({ database_id: databaseId });
      const props = database.properties as Record<string, any>;

      const titleProperty = this.findByType(props, "title") || "Name";
      const statusProperty =
        this.findByType(props, "status") ||
        this.findByType(props, "select") ||
        this.findByName(props, ["status", "state", "stage"]) ||
        "Status";
      const statusProp = props[statusProperty];
      const statusType: "status" | "select" =
        statusProp?.type === "status" ? "status" : "select";

      const statusMapping: TasksConfig["statusMapping"] = { todo: [], in_progress: [], done: [] };
      const options: { name: string }[] =
        statusType === "status"
          ? (statusProp?.status?.options || [])
          : (statusProp?.select?.options || []);

      for (const opt of options) {
        const n = opt.name.toLowerCase();
        if (["done", "complete", "completed", "finished"].some((s) => n.includes(s))) {
          statusMapping.done.push(opt.name);
        } else if (
          n === "in progress" ||
          n.includes("doing") ||
          n.includes("working") ||
          (n.includes("progress") && !n.includes("not")) ||
          (n.includes("started") && !n.includes("not"))
        ) {
          statusMapping.in_progress.push(opt.name);
        } else {
          statusMapping.todo.push(opt.name);
        }
      }

      const config: TasksConfig = {
        databaseId,
        titleProperty,
        statusProperty,
        statusType,
        statusMapping,
        dueDateProperty:
          this.findByType(props, "date") ||
          this.findByName(props, ["due", "date", "deadline", "due date"]),
        priorityProperty: this.findByName(props, ["priority", "importance", "urgency"]),
        projectProperty: this.findByName(props, ["project", "area", "category"]),
      };

      this.config = config;
      memory.saveKV("notion:tasks_config", config);

      console.log(`✓ Notion Tasks connected — database ${databaseId}`);
      console.log(`  Title: ${config.titleProperty}`);
      console.log(`  Status: ${config.statusProperty} (${statusType})`);
      console.log(`  Due Date: ${config.dueDateProperty || "not detected"}`);
      console.log(`  Priority: ${config.priorityProperty || "not detected"}`);

      return true;
    } catch (err) {
      console.error("Failed to connect Notion tasks:", err);
      return false;
    }
  }

  private findByType(props: Record<string, any>, type: string): string | undefined {
    for (const [name, prop] of Object.entries(props)) {
      if ((prop as any).type === type) return name;
    }
    return undefined;
  }

  private findByName(props: Record<string, any>, names: string[]): string | undefined {
    for (const name of Object.keys(props)) {
      if (names.some((n) => name.toLowerCase().includes(n))) return name;
    }
    return undefined;
  }

  private statusFilter(negate = false) {
    if (!this.config) return undefined;
    const doneStatus = this.config.statusMapping.done[0] || "Done";
    const condition =
      this.config.statusType === "status"
        ? negate
          ? { status: { does_not_equal: doneStatus } }
          : { status: { equals: doneStatus } }
        : negate
        ? { select: { does_not_equal: doneStatus } }
        : { select: { equals: doneStatus } };
    return { property: this.config.statusProperty, ...condition };
  }

  async getTodaysTasks(): Promise<Task[]> {
    if (!this.config) return [];
    const filter = this.statusFilter(true);
    if (!filter) return [];
    try {
      const response = await this.client.databases.query({
        database_id: this.config.databaseId,
        filter,
        ...(this.config.dueDateProperty
          ? { sorts: [{ property: this.config.dueDateProperty, direction: "ascending" as const }] }
          : {}),
      });
      return response.results.map((p) => this.parseTask(p as any));
    } catch (err) {
      console.error("Failed to fetch tasks:", err);
      return [];
    }
  }

  async getOverdueTasks(): Promise<Task[]> {
    if (!this.config || !this.config.dueDateProperty) return [];
    const today = new Date().toISOString().split("T")[0];
    const notDone = this.statusFilter(true);
    if (!notDone) return [];
    try {
      const response = await this.client.databases.query({
        database_id: this.config.databaseId,
        filter: {
          and: [
            { property: this.config.dueDateProperty, date: { before: today } },
            notDone,
          ],
        },
      });
      return response.results.map((p) => this.parseTask(p as any));
    } catch {
      return [];
    }
  }

  async getTasksDueToday(): Promise<Task[]> {
    if (!this.config || !this.config.dueDateProperty) return [];
    const today = new Date().toISOString().split("T")[0];
    const notDone = this.statusFilter(true);
    if (!notDone) return [];
    try {
      const response = await this.client.databases.query({
        database_id: this.config.databaseId,
        filter: {
          and: [
            { property: this.config.dueDateProperty, date: { equals: today } },
            notDone,
          ],
        },
      });
      return response.results.map((p) => this.parseTask(p as any));
    } catch {
      return [];
    }
  }

  async getCompletedThisWeek(): Promise<Task[]> {
    if (!this.config) return [];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const doneFilter = this.statusFilter(false);
    if (!doneFilter) return [];
    try {
      const response = await this.client.databases.query({
        database_id: this.config.databaseId,
        filter: {
          and: [
            doneFilter,
            { timestamp: "last_edited_time", last_edited_time: { after: weekAgo.toISOString() } },
          ],
        },
      });
      return response.results.map((p) => this.parseTask(p as any));
    } catch {
      return [];
    }
  }

  async addTask(title: string, options?: { dueDate?: string; priority?: string }): Promise<Task | null> {
    if (!this.config) return null;
    try {
      const properties: Record<string, any> = {
        [this.config.titleProperty]: { title: [{ text: { content: title } }] },
      };

      const todoStatus = this.config.statusMapping.todo[0] || "To Do";
      if (this.config.statusType === "status") {
        properties[this.config.statusProperty] = { status: { name: todoStatus } };
      } else {
        properties[this.config.statusProperty] = { select: { name: todoStatus } };
      }

      if (options?.dueDate && this.config.dueDateProperty) {
        properties[this.config.dueDateProperty] = { date: { start: options.dueDate } };
      }
      if (options?.priority && this.config.priorityProperty) {
        properties[this.config.priorityProperty] = { select: { name: options.priority } };
      }

      const page = await this.client.pages.create({
        parent: { database_id: this.config.databaseId },
        properties,
      });
      console.log(`✓ Task created: ${title}`);
      return this.parseTask(page as any);
    } catch (err) {
      console.error("Failed to create task:", err);
      return null;
    }
  }

  async completeTask(taskId: string): Promise<boolean> {
    return this.updateTaskStatus(taskId, "done");
  }

  async updateTaskStatus(taskId: string, status: "todo" | "in_progress" | "done"): Promise<boolean> {
    if (!this.config) return false;
    const statusName = this.config.statusMapping[status][0];
    if (!statusName) return false;
    try {
      const prop =
        this.config.statusType === "status"
          ? { status: { name: statusName } }
          : { select: { name: statusName } };
      await this.client.pages.update({
        page_id: taskId,
        properties: { [this.config.statusProperty]: prop },
      });
      return true;
    } catch (err) {
      console.error("Failed to update task:", err);
      return false;
    }
  }

  private parseTask(page: any): Task {
    const props = page.properties as Record<string, any>;
    const cfg = this.config!;

    const title =
      props[cfg.titleProperty]?.title?.[0]?.plain_text || "Untitled";

    const rawStatus =
      props[cfg.statusProperty]?.status?.name ||
      props[cfg.statusProperty]?.select?.name ||
      "";
    let status: Task["status"] = "todo";
    if (cfg.statusMapping.done.includes(rawStatus)) status = "done";
    else if (cfg.statusMapping.in_progress.includes(rawStatus)) status = "in_progress";

    const dueDate = cfg.dueDateProperty
      ? props[cfg.dueDateProperty]?.date?.start
      : undefined;

    const rawPriority = cfg.priorityProperty
      ? (props[cfg.priorityProperty]?.select?.name || "").toLowerCase()
      : "";
    let priority: Task["priority"];
    if (rawPriority.includes("high") || rawPriority.includes("urgent")) priority = "high";
    else if (rawPriority.includes("medium") || rawPriority.includes("normal")) priority = "medium";
    else if (rawPriority.includes("low")) priority = "low";

    const project = cfg.projectProperty
      ? props[cfg.projectProperty]?.select?.name
      : undefined;

    return {
      id: page.id,
      title,
      status,
      priority,
      dueDate,
      project,
      createdAt: page.created_time,
      completedAt: status === "done" ? page.last_edited_time : undefined,
    };
  }

  async getContextString(): Promise<string> {
    const [activeTasks, overdue] = await Promise.all([
      this.getTodaysTasks(),
      this.getOverdueTasks(),
    ]);

    if (activeTasks.length === 0 && overdue.length === 0) {
      return "No tasks configured or no active tasks.";
    }

    const lines: string[] = [];

    if (overdue.length > 0) {
      lines.push(`⚠️ ${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}:`);
      overdue.slice(0, 3).forEach((t) => lines.push(`  ${t.title} (due ${t.dueDate})`));
      lines.push("");
    }

    lines.push(`📋 ${activeTasks.length} active task${activeTasks.length !== 1 ? "s" : ""}:`);
    const high = activeTasks.filter((t) => t.priority === "high");
    const rest = activeTasks.filter((t) => t.priority !== "high");

    if (high.length > 0) {
      lines.push("High priority:");
      high.forEach((t) => lines.push(`  [!] ${t.title}`));
    }
    rest.slice(0, 5).forEach((t) => {
      const due = t.dueDate ? ` (due ${t.dueDate})` : "";
      lines.push(`  ${t.title}${due}`);
    });
    if (rest.length > 5) lines.push(`  ... and ${rest.length - 5} more`);

    return lines.join("\n");
  }

  isConfigured(): boolean {
    return this.config !== null;
  }
}

export const notionTasks = new NotionTasksTool();
