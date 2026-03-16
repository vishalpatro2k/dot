const BASE = "http://localhost:3000";

export interface ChatResponse {
  answer: string;
  model: string;
  cost: number;
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

/** Parse the error body for a human-readable message. */
async function readError(res: Response): Promise<Error> {
  try {
    const body = await res.json();
    return new Error(body.error || `Request failed: ${res.status}`);
  } catch {
    return new Error(`Request failed: ${res.status}`);
  }
}

export async function sendChat(message: string): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function startRecording(): Promise<RecordingResponse> {
  const res = await fetch(`${BASE}/recording/start`, { method: "POST" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function stopRecording(): Promise<RecordingResponse> {
  const res = await fetch(`${BASE}/recording/stop`, { method: "POST" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function getStatus(): Promise<ServerStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw await readError(res);
  return res.json();
}
