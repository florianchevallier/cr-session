/**
 * Client du serveur WhisperX (API "Whisper API - Service de transcription audio").
 * Demande toujours la sortie JSON : on garde timestamps, locuteur par mot et scores,
 * qui sont les meilleurs indices pour corriger la diarization.
 */
import { readFile } from "fs/promises";
import { basename } from "path";
import "../config/env.js";

export interface WhisperWord {
  word: string;
  start?: number;
  end?: number;
  score?: number;
  speaker?: string;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: WhisperWord[];
}

export interface WhisperResult {
  segments: WhisperSegment[];
  language?: string;
}

export interface TranscriptionOptions {
  /** Nombre exact de locuteurs (joueurs + MJ). Prioritaire sur min/max. */
  nbSpeaker?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  /** Noms propres et vocabulaire pour guider Whisper (max 1000 caractères). */
  initialPrompt?: string;
  language?: string;
  model?: string;
  onProgress?: (message: string) => void;
}

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 3 * 60 * 60 * 1000;

function config() {
  const url = process.env.WHISPER_API_URL?.replace(/\/+$/, "");
  const key = process.env.WHISPER_API_KEY;
  if (!url) throw new Error("WHISPER_API_URL manquant dans .env");
  return { url, key };
}

function headers(key?: string): Record<string, string> {
  const h: Record<string, string> = { "ngrok-skip-browser-warning": "1" };
  if (key) h["X-API-Key"] = key;
  return h;
}

async function getJson(path: string): Promise<any> {
  const { url, key } = config();
  const res = await fetch(`${url}${path}`, { headers: headers(key) });
  if (!res.ok) throw new Error(`WhisperX ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function startTranscription(
  audio: Buffer,
  filename: string,
  options: TranscriptionOptions = {}
): Promise<string> {
  const { url, key } = config();
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(audio)]), filename);
  form.append("outputFormat", "json");
  form.append("language", options.language ?? "fr");
  form.append("model", options.model ?? "large-v3");
  form.append("diarize", "true");
  if (options.nbSpeaker) {
    form.append("nbSpeaker", String(options.nbSpeaker));
  } else {
    // Sans aucune valeur, le serveur impose 2 locuteurs : toujours borner.
    form.append("minSpeakers", String(options.minSpeakers ?? 2));
    form.append("maxSpeakers", String(options.maxSpeakers ?? 8));
  }
  if (options.initialPrompt) {
    form.append("initialPrompt", options.initialPrompt.slice(0, 1000));
  }

  const res = await fetch(`${url}/process`, {
    method: "POST",
    headers: headers(key),
    body: form,
  });
  if (!res.ok) throw new Error(`WhisperX /process → HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body.jobId) throw new Error(`WhisperX /process: réponse inattendue ${JSON.stringify(body)}`);
  return body.jobId as string;
}

export async function waitForTranscription(
  jobId: string,
  onProgress?: (message: string) => void
): Promise<WhisperResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastLog = "";
  while (Date.now() < deadline) {
    const { job } = await getJson(`/jobs/${jobId}`);
    const logs: string[] = job.logs ?? [];
    const latest = logs[logs.length - 1];
    if (latest && latest !== lastLog) {
      lastLog = latest;
      onProgress?.(latest);
    }
    if (job.status === "completed") return getJson(`/jobs/${jobId}/result`);
    if (job.status === "failed") {
      throw new Error(`Transcription échouée: ${logs.slice(-5).join(" | ")}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Transcription ${jobId}: délai dépassé`);
}

export async function transcribeFile(
  path: string,
  options: TranscriptionOptions = {}
): Promise<WhisperResult> {
  const audio = await readFile(path);
  const jobId = await startTranscription(audio, basename(path), options);
  options.onProgress?.(`job ${jobId} démarré`);
  return waitForTranscription(jobId, options.onProgress);
}
