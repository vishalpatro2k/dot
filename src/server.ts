/**
 * HTTP API Server for Dot
 *
 * Exposes the agent + meeting recording over HTTP so the Dot app can connect.
 *
 * Usage: npm run server
 *
 * Endpoints:
 *   GET  /health              - Health check
 *   GET  /status              - App state (idle | recording | processing)
 *   POST /chat                - Send a message to the agent
 *   GET  /brief               - Morning briefing
 *   GET  /stats               - Usage statistics
 *   POST /recording/start     - Start capturing system audio (BlackHole)
 *   POST /recording/stop      - Stop capture and run full pipeline → Notion
 */

import "dotenv/config"; // must be first — loads ANTHROPIC_API_KEY before any module initializes Anthropic()

import express from "express";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { agent } from "./agent.js";
import { gmail } from "./tools/gmail.js";
import { calendar } from "./tools/calendar.js";
import { wellness } from "./tools/wellness-analyzer.js";
import { healthData } from "./tools/health-data.js";
import { notionTasks } from "./tools/notion-tasks.js";
import { nudgeEngine, type Nudge } from "./tools/nudges.js";
import { generateWeeklyReview } from "./tools/weekly-review.js";
import { focusMode } from "./tools/focus-mode.js";
import { meetingPrep } from "./tools/meeting-prep.js";
import { smartScheduler } from "./tools/smart-scheduling.js";
import { goalTracker } from "./tools/goals.js";
import { predictiveNudges } from "./tools/predictive-nudges.js";
import { actionExecutor } from "./tools/action-executor.js";
import { conversationManager } from "./tools/conversation-manager.js";
import { userProfile } from "./tools/user-profile.js";
import { followUpGenerator } from "./tools/follow-up-suggestions.js";
import { getContextBarState } from "./tools/context-bar.js";
import { isOnboardingComplete, completeOnboarding, generateWelcomeMessage } from "./tools/onboarding.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = process.cwd();
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv", "bin", "python3");
const RECORDINGS_DIR = path.join(PROJECT_ROOT, "data", "recordings");
const PIPELINE_SCRIPT = path.join(PROJECT_ROOT, "transcribe_speaker.py");

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ── Recording state ───────────────────────────────────────────────────────────

type AppState = "idle" | "recording" | "processing";

const rec: {
  state: AppState;
  process: ChildProcess | null;
  wavPath: string | null;
  title: string | null;
  startTime: Date | null;
  lastSummary: string | null;
  lastError: string | null;
} = {
  state: "idle",
  process: null,
  wavPath: null,
  title: null,
  startTime: null,
  lastSummary: null,
  lastError: null,
};

function findBlackholeDevice(): number {
  try {
    const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true').toString();
    const m = out.match(/\[(\d+)\]\s+BlackHole 2ch/);
    return m ? parseInt(m[1], 10) : 1;
  } catch { return 1; }
}

function timestampedTitle(): string {
  return `Meeting ${new Date().toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  })}`;
}

function runPipeline(wavPath: string, title: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(VENV_PYTHON)) {
      return reject(new Error("Python venv not found at .venv/. Run the setup steps first."));
    }
    const proc = spawn(
      VENV_PYTHON,
      [PIPELINE_SCRIPT, wavPath, "--identify", "--summarize", "--title", title],
      { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let errOut = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => {
      process.stderr.write(c);   // still stream to terminal
      errOut += c.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else {
        // Prefer the last non-empty stderr line (Python's sys.exit message lives there)
        const lastErrLine = errOut.trim().split(/\r?\n/).reverse().find((l) => l.trim()) ?? "";
        const msg = lastErrLine.startsWith("Error:") || lastErrLine.includes("Whisper")
          ? lastErrLine
          : `Pipeline exited ${code}${lastErrLine ? ": " + lastErrLine : ""}`;
        reject(new Error(msg));
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /status  →  what the dot app polls
app.get("/status", (_req, res) => {
  const duration = rec.startTime
    ? Math.floor((Date.now() - rec.startTime.getTime()) / 1000)
    : undefined;
  res.json({
    state: rec.state,
    recordingDuration: duration,
    lastSummary: rec.lastSummary,
    lastError: rec.lastError,
    hasNudges: false,
  });
});

// POST /chat
app.post("/chat", async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return void res.status(400).json({ error: "message required" });
  try {
    const r = await agent.ask(message);
    res.json({ answer: r.answer, model: r.model, cost: r.cost, suggestions: r.suggestions ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /context — real-time context bar state + quick actions
app.get("/context", async (_req, res) => {
  try {
    const contextBar = await getContextBarState();
    const quickActions = followUpGenerator.quickActions();
    res.json({ contextBar, quickActions });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /profile
app.get("/profile", (_req, res) => {
  res.json(userProfile.load());
});

// POST /profile
app.post("/profile", (req, res) => {
  try {
    userProfile.save(req.body ?? {});
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /profile/name
app.post("/profile/name", (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return void res.status(400).json({ error: "name required" });
  userProfile.setName(name);
  res.json({ success: true, name });
});

// POST /conversation/clear
app.post("/conversation/clear", (_req, res) => {
  conversationManager.clear();
  res.json({ success: true });
});

// GET /onboarding
app.get("/onboarding", (_req, res) => {
  res.json({ completed: isOnboardingComplete(), name: userProfile.getName() });
});

// POST /onboarding
app.post("/onboarding", (req, res) => {
  const { name, preferences } = req.body ?? {};
  if (!name) return void res.status(400).json({ error: "name required" });
  completeOnboarding(name, preferences);
  res.json({ success: true, welcome: generateWelcomeMessage(name) });
});

// GET /brief — morning briefing via agent (LLM-formatted)
app.get("/brief", async (_req, res) => {
  try {
    const r = await agent.morningBrief();
    res.json({ answer: r.answer, model: r.model });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /recap — end-of-day recap via agent (LLM-formatted)
app.get("/recap", async (_req, res) => {
  try {
    const r = await agent.ask("Give me my day recap.");
    res.json({ answer: r.answer, model: r.model });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /wellness — raw wellness stats + patterns
app.get("/wellness", async (_req, res) => {
  try {
    const [{ stats, insights }, weekComparison, patterns] = await Promise.all([
      wellness.analyzeTodayCalendar(),
      wellness.getWeekComparison(),
      Promise.resolve(wellness.getPatterns()),
    ]);
    res.json({ today: stats, insights, week: weekComparison, patterns });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats
app.get("/stats", (_req, res) => {
  res.json(agent.getStats());
});

// GET /emails/unread
app.get("/emails/unread", async (_req, res) => {
  try {
    const emails = await gmail.getUnreadEmails(20);
    const count = await gmail.getUnreadCount();
    res.json({ count, emails });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /emails/smart — filtered inbox (only actionable emails)
app.get("/emails/smart", async (_req, res) => {
  try {
    const result = await gmail.getSmartInbox(50);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /calendar/stats
app.get("/calendar/stats", async (_req, res) => {
  try {
    const [todayEvents, weekStats] = await Promise.all([
      calendar.getTodaysEvents(),
      calendar.getWeekStats(),
    ]);
    res.json({ today: todayEvents, week: weekStats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /recording/start
app.post("/recording/start", (req, res) => {
  if (rec.state === "recording") {
    return void res.status(400).json({ error: "Already recording" });
  }

  const title: string = req.body?.title || timestampedTitle();
  const deviceIndex = findBlackholeDevice();

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const wavPath = path.join(RECORDINGS_DIR, `${ts}.wav`);

  const proc = spawn(
    "ffmpeg",
    ["-y", "-f", "avfoundation", "-i", `none:${deviceIndex}`,
     "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", wavPath],
    { stdio: ["ignore", "ignore", "ignore"], detached: true }
  );

  rec.state = "recording";
  rec.process = proc;
  rec.wavPath = wavPath;
  rec.title = title;
  rec.startTime = new Date();
  rec.lastSummary = null;
  rec.lastError = null;

  console.log(`\n● Recording started → ${wavPath}`);
  res.json({ status: "started", title });
});

// POST /recording/stop
app.post("/recording/stop", async (req, res) => {
  if (rec.state !== "recording" || !rec.process) {
    return void res.status(400).json({ error: "Not recording" });
  }

  const proc = rec.process;
  const wavPath = rec.wavPath!;
  const title = rec.title || timestampedTitle();

  // Flip state immediately so /status reflects it
  rec.state = "processing";
  rec.process = null;
  rec.startTime = null;

  // Respond right away — pipeline runs in background
  res.json({ status: "processing" });

  // Gracefully stop ffmpeg (lets it write WAV headers)
  await new Promise<void>((resolve) => {
    proc.kill("SIGINT");
    proc.once("close", resolve);
    setTimeout(resolve, 4000); // fallback
  });

  console.log(`\n■ Recording stopped. Running pipeline on ${wavPath}…`);

  runPipeline(wavPath, title)
    .then((summary) => {
      rec.lastSummary = summary;
      rec.state = "idle";
      console.log("\n✓ Pipeline complete. Summary saved to Notion.");
    })
    .catch((err) => {
      rec.lastError = err.message;
      rec.state = "idle";
      console.error("\n✗ Pipeline error:", err.message);
    });
});

// ── Tasks endpoints ───────────────────────────────────────────────────────────

// GET /tasks
app.get("/tasks", async (_req, res) => {
  try {
    const [tasks, overdue] = await Promise.all([
      notionTasks.getTodaysTasks(),
      notionTasks.getOverdueTasks(),
    ]);
    res.json({ tasks, overdue });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /tasks
app.post("/tasks", async (req, res) => {
  const { title, dueDate, priority } = req.body ?? {};
  if (!title) return void res.status(400).json({ error: "title required" });
  try {
    const task = await notionTasks.addTask(title, { dueDate, priority });
    res.json({ success: true, task });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /tasks/:id/complete
app.post("/tasks/:id/complete", async (req, res) => {
  try {
    const success = await notionTasks.completeTask(req.params.id);
    res.json({ success });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /nudges
app.get("/nudges", async (_req, res) => {
  try {
    const nudges = await nudgeEngine.getPendingNudges();
    res.json({ nudges });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /review/weekly
app.get("/review/weekly", async (_req, res) => {
  try {
    const review = await generateWeeklyReview();
    res.json(review);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Focus Mode endpoints ──────────────────────────────────────────────────────

// POST /focus/start
app.post("/focus/start", async (req, res) => {
  const { minutes = 90, task } = req.body ?? {};
  try {
    const session = await focusMode.start(Number(minutes), task);
    res.json({ success: true, session });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /focus/stop
app.post("/focus/stop", async (_req, res) => {
  try {
    const session = await focusMode.stop();
    res.json({ success: true, session });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /focus/extend
app.post("/focus/extend", async (req, res) => {
  const { minutes = 30 } = req.body ?? {};
  try {
    const session = await focusMode.extend(Number(minutes));
    res.json({ success: true, session });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /focus/status
app.get("/focus/status", (_req, res) => {
  res.json(focusMode.getStatus());
});

// GET /focus/stats
app.get("/focus/stats", (_req, res) => {
  res.json(focusMode.getStats());
});

// ── Meeting Prep endpoints ────────────────────────────────────────────────────

// GET /meeting/prep?q=<query>
app.get("/meeting/prep", async (req, res) => {
  const q = String(req.query.q ?? "");
  if (!q) return void res.status(400).json({ error: "q (meeting query) required" });
  try {
    const ctx = await meetingPrep.prepareForMeeting(q);
    if (!ctx) return void res.status(404).json({ error: "No matching meeting found" });
    res.json(ctx);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /meeting/notes
app.post("/meeting/notes", (req, res) => {
  const { title, summary, actionItems } = req.body ?? {};
  if (!title || !summary) return void res.status(400).json({ error: "title and summary required" });
  try {
    meetingPrep.saveMeetingNotes(title, summary, actionItems);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Smart Scheduling endpoints ────────────────────────────────────────────────

// GET /schedule/find?duration=60&days=5
app.get("/schedule/find", async (req, res) => {
  const duration = Number(req.query.duration ?? 60);
  const days = Number(req.query.days ?? 5);
  try {
    const suggestion = await smartScheduler.findFreeSlots(duration, days);
    res.json({ formatted: smartScheduler.formatSuggestion(suggestion), ...suggestion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /schedule/focus-block?duration=120
app.get("/schedule/focus-block", async (req, res) => {
  const duration = Number(req.query.duration ?? 120);
  try {
    const suggestion = await smartScheduler.suggestFocusBlock(duration);
    res.json({ formatted: smartScheduler.formatSuggestion(suggestion), ...suggestion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /schedule/conflicts  { start: ISO string, duration: 60 }
app.post("/schedule/conflicts", async (req, res) => {
  const { start, duration = 60 } = req.body ?? {};
  if (!start) return void res.status(400).json({ error: "start (ISO date string) required" });
  try {
    const result = await smartScheduler.checkConflicts(new Date(start), Number(duration));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Goals endpoints ───────────────────────────────────────────────────────────

// GET /goals
app.get("/goals", (_req, res) => {
  const progress = goalTracker.getProgress();
  res.json({ goals: progress });
});

// POST /goals  { type, period, target }
app.post("/goals", (req, res) => {
  const { type, period, target } = req.body ?? {};
  if (!type || !period || target === undefined) {
    return void res.status(400).json({ error: "type, period, and target are required" });
  }
  try {
    const goal = goalTracker.addGoal(type, period, Number(target));
    res.json({ goal });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /goals/:id
app.delete("/goals/:id", (req, res) => {
  const removed = goalTracker.removeGoal(req.params.id);
  res.json({ removed });
});

// ── Predictive nudges endpoint ────────────────────────────────────────────────

// GET /insights
app.get("/insights", async (_req, res) => {
  try {
    const nudges = await predictiveNudges.getNudges();
    res.json({ nudges });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Action endpoint ───────────────────────────────────────────────────────────

// POST /action  { type, ... }
app.post("/action", async (req, res) => {
  const action = req.body ?? {};
  if (!action.type) {
    return void res.status(400).json({ error: "action type required" });
  }
  try {
    // Parse date strings to Date objects
    if (action.startTime) action.startTime = new Date(action.startTime);
    if (action.endTime) action.endTime = new Date(action.endTime);
    const result = await actionExecutor.execute(action);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Apple Health endpoints ────────────────────────────────────────────────────

// POST /apple-health  — called by iOS Shortcut each morning
app.post("/apple-health", (req, res) => {
  try {
    const d = req.body ?? {};

    if (!d.date || !d.sleep) {
      return void res.status(400).json({ error: "Missing required fields: date, sleep" });
    }

    const payload = {
      date: String(d.date),
      sleep: {
        totalHours: parseFloat(d.sleep.totalHours) || 0,
        inBedHours: parseFloat(d.sleep.inBedHours) || 0,
        efficiency: parseFloat(d.sleep.efficiency) || 0,
        bedtime: String(d.sleep.bedtime || ""),
        wakeTime: String(d.sleep.wakeTime || ""),
        quality: d.sleep.quality,
      },
      activity: {
        steps: parseInt(d.activity?.steps) || 0,
        activeCalories: parseInt(d.activity?.activeCalories) || 0,
        exerciseMinutes: parseInt(d.activity?.exerciseMinutes) || 0,
        standHours: parseInt(d.activity?.standHours) || 0,
        moveGoalPercent: parseFloat(d.activity?.moveGoalPercent) || 0,
      },
      vitals: d.vitals
        ? { restingHR: parseInt(d.vitals.restingHR) || 0, hrv: parseInt(d.vitals.hrv) || 0 }
        : undefined,
      receivedAt: new Date().toISOString(),
    };

    healthData.saveHealthData(payload);
    const insights = healthData.generateHealthInsights(payload);
    res.json({ success: true, message: `Health data saved for ${payload.date}`, insights });
  } catch (e: any) {
    console.error("Health data error:", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /apple-health/summary
app.get("/apple-health/summary", (_req, res) => {
  try {
    const sleep = healthData.getLastNightSleep();
    const patterns = healthData.getHealthPatterns();
    const history = healthData.getRecentHealth(7);
    res.json({ lastNight: sleep, patterns, history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /apple-health/insights
app.get("/apple-health/insights", (_req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const data = healthData.getHealthData(today) ?? healthData.getHealthData(yesterday.toISOString().split("T")[0]);
    if (!data) return void res.json({ insights: [], message: "No health data yet" });
    const patterns = healthData.getHealthPatterns();
    res.json({ insights: healthData.generateHealthInsights(data, patterns) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await agent.init();

  // Start nudge engine and log nudges to console
  nudgeEngine.start();
  nudgeEngine.on("nudge", (nudge: Nudge) => {
    console.log(`\n🔔 Nudge [${nudge.priority}]: ${nudge.title} — ${nudge.message}`);
  });

  // Focus mode event listeners
  focusMode.on("start", (s) => console.log(`\n🎯 Focus started: ${s.duration}min${s.task ? ` — ${s.task}` : ""}`));
  focusMode.on("complete", (s) => console.log(`\n✅ Focus complete: ${s.actualMinutes}min of deep work`));
  focusMode.on("stop", (s) => console.log(`\n⏹  Focus stopped after ${s.actualMinutes}min`));

  app.listen(PORT, () => {
    console.log(`\n● Dot server  http://localhost:${PORT}`);
    console.log("  GET  /status");
    console.log("  POST /chat");
    console.log("  POST /recording/start");
    console.log("  POST /recording/stop");
    console.log("  GET  /emails/unread");
    console.log("  GET  /emails/smart");
    console.log("  GET  /calendar/stats");
    console.log("  GET  /recap");
    console.log("  GET  /wellness");
    console.log("  GET  /tasks");
    console.log("  POST /tasks");
    console.log("  POST /tasks/:id/complete");
    console.log("  GET  /nudges");
    console.log("  GET  /review/weekly");
    console.log("  POST /focus/start  POST /focus/stop  POST /focus/extend");
    console.log("  GET  /focus/status  GET /focus/stats");
    console.log("  GET  /meeting/prep  POST /meeting/notes");
    console.log("  GET  /schedule/find  GET /schedule/focus-block  POST /schedule/conflicts");
    console.log("  GET  /goals  POST /goals  DELETE /goals/:id");
    console.log("  GET  /insights  POST /action");
    console.log("  GET  /context  GET/POST /profile  POST /profile/name");
    console.log("  POST /conversation/clear  GET/POST /onboarding");
    console.log("  POST /apple-health");
    console.log("  GET  /apple-health/summary");
    console.log("  GET  /apple-health/insights\n");
  });
}

start().catch(console.error);
