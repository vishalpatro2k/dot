/**
 * Slack Integration
 * 
 * Setup:
 * 1. Go to https://api.slack.com/apps
 * 2. Create a new app with these scopes:
 *    - channels:history, channels:read
 *    - im:history, im:read  
 *    - users:read
 *    - search:read
 * 3. Install to workspace and copy Bot Token
 * 4. Set SLACK_TOKEN in .env
 */

import { WebClient } from "@slack/web-api";

export interface SlackMessage {
  channel: string;
  channelId: string;
  user: string;
  text: string;
  timestamp: string;
  permalink?: string;
}

export interface SlackDM {
  userId: string;
  userName: string;
  unreadCount: number;
  lastMessage?: string;
}

export class SlackTool {
  private client: WebClient | null = null;
  private userId: string | null = null;
  private connected = false;

  async init(): Promise<boolean> {
    const token = process.env.SLACK_TOKEN;
    
    if (!token) {
      console.log("⚠️  No SLACK_TOKEN found. Slack disabled.");
      return false;
    }

    try {
      this.client = new WebClient(token);
      const auth = await this.client.auth.test();
      this.userId = auth.user_id as string;
      this.connected = true;
      console.log(`✓ Slack connected as ${auth.user}`);
      return true;
    } catch (error) {
      console.error("Slack init error:", error);
      return false;
    }
  }

  async getUnreadMentions(): Promise<SlackMessage[]> {
    if (!this.client || !this.userId) return [];

    try {
      const response = await this.client.search.messages({
        query: `<@${this.userId}>`,
        sort: "timestamp",
        count: 20,
      });

      return (response.messages?.matches || []).map((m: any) => ({
        channel: m.channel?.name || "Unknown",
        channelId: m.channel?.id || "",
        user: m.username || "Unknown",
        text: m.text || "",
        timestamp: m.ts || "",
        permalink: m.permalink,
      }));
    } catch (error) {
      console.error("Slack mentions error:", error);
      return [];
    }
  }

  async getUnreadDMs(): Promise<SlackDM[]> {
    if (!this.client) return [];

    try {
      const convos = await this.client.conversations.list({
        types: "im",
        exclude_archived: true,
      });

      const unread: SlackDM[] = [];

      for (const conv of convos.channels || []) {
        if ((conv.unread_count || 0) > 0) {
          let userName = "Unknown";
          try {
            const userInfo = await this.client.users.info({ user: conv.user! });
            userName = userInfo.user?.real_name || userInfo.user?.name || "Unknown";
          } catch {}

          const history = await this.client.conversations.history({
            channel: conv.id!,
            limit: 1,
          });

          unread.push({
            userId: conv.user || "",
            userName,
            unreadCount: conv.unread_count || 0,
            lastMessage: history.messages?.[0]?.text,
          });
        }
      }

      return unread;
    } catch (error) {
      console.error("Slack DMs error:", error);
      return [];
    }
  }

  async getRecentChannelActivity(): Promise<SlackMessage[]> {
    if (!this.client) return [];

    try {
      // Get channels you're a member of
      const channels = await this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 10,
      });

      const messages: SlackMessage[] = [];

      for (const channel of (channels.channels || []).slice(0, 5)) {
        if (!channel.is_member) continue;

        const history = await this.client.conversations.history({
          channel: channel.id!,
          limit: 5,
        });

        for (const msg of history.messages || []) {
          if (msg.user !== this.userId) {
            messages.push({
              channel: channel.name || "Unknown",
              channelId: channel.id || "",
              user: msg.user || "Unknown",
              text: (msg.text || "").slice(0, 200),
              timestamp: msg.ts || "",
            });
          }
        }
      }

      // Sort by timestamp, most recent first
      return messages.sort((a, b) => parseFloat(b.timestamp) - parseFloat(a.timestamp)).slice(0, 10);
    } catch (error) {
      console.error("Slack activity error:", error);
      return [];
    }
  }

  async getContextString(): Promise<string> {
    if (!this.connected) return "Slack not connected.";

    const [mentions, dms] = await Promise.all([
      this.getUnreadMentions(),
      this.getUnreadDMs(),
    ]);

    const lines: string[] = [];

    if (dms.length > 0) {
      lines.push(`**Unread DMs (${dms.length}):**`);
      for (const dm of dms.slice(0, 5)) {
        lines.push(`• ${dm.userName}: ${dm.unreadCount} unread`);
      }
    }

    if (mentions.length > 0) {
      lines.push(`\n**Recent Mentions (${mentions.length}):**`);
      for (const m of mentions.slice(0, 5)) {
        const preview = m.text.slice(0, 100) + (m.text.length > 100 ? "..." : "");
        lines.push(`• #${m.channel} - ${m.user}: "${preview}"`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : "No unread messages.";
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const slack = new SlackTool();
