#!/usr/bin/env tsx
/**
 * CLI Interface
 * 
 * Usage:
 *   npm run cli                          # Interactive mode
 *   npm run cli -- "What's my day?"      # Single query
 *   npm run cli -- record-meeting        # Record + transcribe + summarize → Notion
 *   npm run cli -- summarize <file.wav>  # Summarize an existing recording → Notion
 *   npm run cli -- --auth-calendar       # Authenticate calendar
 *   npm run cli -- --stats               # Show usage stats
 *   npm run cli -- --brief               # Morning briefing
 */

import "dotenv/config";
import * as readline from "readline";
import { agent } from "./agent.js";
import { calendar } from "./tools/calendar.js";
import { recordMeeting, summarizeMeeting } from "./commands/meeting.js";

const args = process.argv.slice(2);

async function main() {
  // record-meeting — record system audio then run full pipeline
  if (args[0] === "record-meeting") {
    await recordMeeting();
    return;
  }

  // summarize <file.wav> — run pipeline on an existing recording
  if (args[0] === "summarize") {
    if (!args[1]) {
      console.error("Usage: npm run cli -- summarize <file.wav>");
      process.exit(1);
    }
    await summarizeMeeting(args[1]);
    return;
  }

  // Handle special commands
  if (args.includes("--auth-calendar")) {
    await calendar.authenticate();
    return;
  }

  if (args.includes("--stats")) {
    await agent.init();
    const stats = agent.getStats();
    console.log("\n📊 Usage Statistics\n");
    console.log("Router:");
    console.log(`  Total requests: ${stats.router.totalRequests}`);
    console.log(`  Haiku: ${stats.router.haikuRequests} | Sonnet: ${stats.router.sonnetRequests}`);
    console.log(`  Cache hit rate: ${stats.router.cacheHitRate.toFixed(1)}%`);
    console.log(`  Total cost: $${stats.router.totalCost.toFixed(4)}`);
    console.log(`  Avg cost/request: $${stats.router.avgCostPerRequest.toFixed(6)}`);
    console.log("\nMemory:");
    console.log(`  Stored memories: ${stats.memory.memories}`);
    console.log(`  Conversation turns: ${stats.memory.conversations}`);
    console.log(`  Cumulative cost: $${stats.memory.totalCost.toFixed(4)}`);
    return;
  }

  if (args.includes("--brief")) {
    await agent.init();
    console.log("\n☀️ Morning Briefing\n");
    const response = await agent.morningBrief();
    console.log(response.answer);
    console.log(`\n[${response.model} | $${response.cost.toFixed(6)} | Cache: ${response.cached ? "✓" : "✗"}]\n`);
    return;
  }

  // Initialize agent
  await agent.init();

  // Single query mode
  if (args.length > 0 && !args[0].startsWith("--")) {
    const query = args.join(" ");
    const response = await agent.ask(query);
    console.log(`\n${response.answer}`);
    console.log(`\n[${response.model} | $${response.cost.toFixed(6)} | Cache: ${response.cached ? "✓" : "✗"}]\n`);
    return;
  }

  // Interactive mode
  console.log("Type your questions (Ctrl+C to exit)\n");
  console.log("Commands: /stats, /brief, /clear, /exit\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const query = input.trim();
      
      if (!query) {
        prompt();
        return;
      }

      // Handle commands
      if (query === "/exit" || query === "/quit") {
        console.log("\nGoodbye! 👋\n");
        rl.close();
        return;
      }

      if (query === "/stats") {
        const stats = agent.getStats();
        console.log(`\n📊 Session: ${stats.router.totalRequests} requests, $${stats.router.totalCost.toFixed(4)} total`);
        console.log(`   Haiku: ${stats.router.haikuRequests} | Sonnet: ${stats.router.sonnetRequests}`);
        console.log(`   Cache hit rate: ${stats.router.cacheHitRate.toFixed(1)}%\n`);
        prompt();
        return;
      }

      if (query === "/brief") {
        console.log("\nAgent: Getting your morning brief...\n");
        const response = await agent.morningBrief();
        console.log(`Agent: ${response.answer}`);
        console.log(`\n[${response.model} | $${response.cost.toFixed(6)} | Cache: ${response.cached ? "✓" : "✗"}]\n`);
        prompt();
        return;
      }

      if (query === "/clear") {
        agent.clearHistory();
        console.log("\n✓ Conversation history cleared\n");
        prompt();
        return;
      }

      // Regular query
      try {
        const response = await agent.ask(query);
        console.log(`\nAgent: ${response.answer}`);
        console.log(`\n[${response.model} | $${response.cost.toFixed(6)} | Cache: ${response.cached ? "✓" : "✗"}]\n`);
      } catch (error: any) {
        console.error(`\n❌ Error: ${error.message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
