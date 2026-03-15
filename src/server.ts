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

import express from "express";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { agent } from "./agent.js";
import "dotenv/config";

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
    proc.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    let out = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`Pipeline exited ${code}`));
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
    res.json({ answer: r.answer, model: r.model, cost: r.cost });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /brief
app.get("/brief", async (_req, res) => {
  try {
    const r = await agent.morningBrief();
    res.json({ answer: r.answer, model: r.model });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats
app.get("/stats", (_req, res) => {
  res.json(agent.getStats());
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

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await agent.init();
  app.listen(PORT, () => {
    console.log(`\n● Dot server  http://localhost:${PORT}`);
    console.log("  GET  /status");
    console.log("  POST /chat");
    console.log("  POST /recording/start");
    console.log("  POST /recording/stop\n");
  });
}

start().catch(console.error);
