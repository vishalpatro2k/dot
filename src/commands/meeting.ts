/**
 * meeting.ts — record-meeting and summarize commands
 *
 * record-meeting  Records system audio (BlackHole) until Ctrl+C, then runs
 *                 the full pipeline: transcribe → diarize → identify → summarize → Notion
 *
 * summarize       Runs the same pipeline on an existing WAV file
 */

import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";

const PROJECT_ROOT = process.cwd();
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv", "bin", "python3");
const RECORDINGS_DIR = path.join(PROJECT_ROOT, "data", "recordings");
const PIPELINE_SCRIPT = path.join(PROJECT_ROOT, "transcribe_speaker.py");

// ── helpers ───────────────────────────────────────────────────────────────────

function findBlackholeDevice(): number {
  try {
    const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true').toString();
    const m = out.match(/\[(\d+)\]\s+BlackHole 2ch/);
    return m ? parseInt(m[1], 10) : 1;
  } catch {
    return 1;
  }
}

function timestampedTitle(): string {
  return `Meeting ${new Date().toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  })}`;
}

async function promptTitle(defaultTitle: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Meeting title [${defaultTitle}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultTitle);
    });
  });
}

// ── recording ─────────────────────────────────────────────────────────────────

function record(outputPath: string): Promise<void> {
  const deviceIndex = findBlackholeDevice();

  return new Promise((resolve, reject) => {
    // detached: true puts ffmpeg in its own process group so that Ctrl+C
    // (SIGINT to Node's process group) does NOT kill ffmpeg automatically.
    // We catch SIGINT in Node, signal ffmpeg ourselves, wait for it to
    // finalise the file, then continue to the pipeline.
    const ffmpeg = spawn(
      "ffmpeg",
      ["-y", "-f", "avfoundation", "-i", `none:${deviceIndex}`,
       "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", outputPath],
      { stdio: ["ignore", "ignore", "ignore"], detached: true },
    );

    let stopped = false;
    const stop = () => {
      if (!stopped) {
        stopped = true;
        ffmpeg.kill("SIGINT"); // graceful stop — ffmpeg finalises the WAV
      }
    };

    // Prevent Node from exiting on Ctrl+C; handle it ourselves
    process.on("SIGINT", stop);

    ffmpeg.on("close", (code) => {
      process.removeListener("SIGINT", stop);
      // ffmpeg exits 255 on graceful SIGINT stop — treat as success
      if (stopped || code === 0 || code === 255) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// ── pipeline ──────────────────────────────────────────────────────────────────

function runPipeline(wavPath: string, title: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(VENV_PYTHON)) {
      return reject(new Error(`Python venv not found at ${VENV_PYTHON}. Run: python3 -m venv .venv && source .venv/bin/activate && pip install pyannote.audio anthropic notion-client`));
    }
    if (!fs.existsSync(PIPELINE_SCRIPT)) {
      return reject(new Error(`Pipeline script not found: ${PIPELINE_SCRIPT}`));
    }

    const proc = spawn(
      VENV_PYTHON,
      [PIPELINE_SCRIPT, wavPath, "--identify", "--summarize", "--title", title],
      { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );

    // Stream progress (stderr) live to terminal
    proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    // Collect summary (stdout)
    let summary = "";
    proc.stdout.on("data", (chunk: Buffer) => { summary += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0) resolve(summary.trim());
      else reject(new Error(`Pipeline exited with code ${code}`));
    });
  });
}

// ── public commands ───────────────────────────────────────────────────────────

export async function recordMeeting(): Promise<void> {
  console.log();

  const defaultTitle = timestampedTitle();
  const title = await promptTitle(defaultTitle);

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const wavPath = path.join(RECORDINGS_DIR, `${timestamp}.wav`);

  console.log("\n● Recording... press Ctrl+C to stop\n");

  await record(wavPath);
  console.log(`\n✓ Recording saved (${(fs.statSync(wavPath).size / 1024).toFixed(0)} KB)`);

  const fileSize = fs.statSync(wavPath).size;
  if (fileSize < 10_000) {
    console.log("⚠  Recording is very short — transcript may be empty.");
  }

  console.log("\nProcessing...\n");
  const summary = await runPipeline(wavPath, title);

  console.log("\n─────────────────────────────────────\n");
  console.log(summary);
  console.log("\n─────────────────────────────────────\n");
}

export async function summarizeMeeting(wavPath: string): Promise<void> {
  const resolved = path.resolve(wavPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${resolved}`);
    process.exit(1);
  }

  console.log();
  const defaultTitle = timestampedTitle();
  const title = await promptTitle(defaultTitle);

  console.log("\nProcessing...\n");
  const summary = await runPipeline(resolved, title);

  console.log("\n─────────────────────────────────────\n");
  console.log(summary);
  console.log("\n─────────────────────────────────────\n");
}
