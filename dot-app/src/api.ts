const BASE = "http://localhost:3000";

export interface ChatResponse {
  answer: string;
  model: string;
}

export interface RecordingResponse {
  status: string;
  summary?: string;
}

export interface ServerStatus {
  state: "idle" | "recording" | "processing" | string;
  recordingDuration?: number;
  hasNudges?: boolean;
  lastSummary?: string | null;
  lastError?: string | null;
}

export async function sendChat(message: string): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status}`);
  return res.json();
}

export async function startRecording(): Promise<RecordingResponse> {
  const res = await fetch(`${BASE}/recording/start`, { method: "POST" });
  if (!res.ok) throw new Error(`Start recording failed: ${res.status}`);
  return res.json();
}

export async function stopRecording(): Promise<RecordingResponse> {
  const res = await fetch(`${BASE}/recording/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Stop recording failed: ${res.status}`);
  return res.json();
}

export async function getStatus(): Promise<ServerStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw new Error(`Status failed: ${res.status}`);
  return res.json();
}
