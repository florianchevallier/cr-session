/**
 * File des traitements en mémoire + flux SSE reprenable (le client peut se reconnecter à un job en cours).
 * Un redémarrage du serveur perd les jobs en cours, y compris ceux en attente de revue.
 */
import type { Request, Response } from "express";
import { mkdirSync, renameSync, rmSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { dataDir } from "../config/database.js";
import { AUDIO_EXTENSIONS, initSSE, writeSSEEvent } from "../lib/http.js";
import type { PlayerDraft } from "../report/types.js";
import type { ReviewDecision, ReviewItem } from "../pipeline/ledger-pipeline.js";

export const jobsDir = resolve(dataDir, "jobs");
mkdirSync(jobsDir, { recursive: true });

export type JobStatus = "pending" | "running" | "review" | "completed" | "failed";
export const JOB_STATUSES: JobStatus[] = ["pending", "running", "review", "completed", "failed"];

export interface JobInput {
  /** Transcript texte/JSON (vide quand la séance arrive en audio). */
  rawTranscript: string;
  /** Audio de la séance, déplacé dans le dossier du job à la création. */
  audioPath?: string;
  skipReview: boolean;
  transcriptName: string;
  universeContext: string;
  sessionHistory: string;
  universeName: string;
  playerInfo: PlayerDraft[];
}

export interface JobEvent {
  id: number;
  type: string;
  data: unknown;
  timestamp: string;
}

export interface Job {
  id: string;
  dir: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  events: JobEvent[];
  listeners: Set<(event: JobEvent) => void>;
  nextEventId: number;
  error: string | null;
  /** Audio converti (mp3 16 kHz) : écoute des extraits et échantillons de voix. */
  playableAudioPath?: string;
  review?: { items: ReviewItem[]; candidates: string[]; resolve: (d: ReviewDecision[]) => void };
}

const jobs = new Map<string, Job>();
const RETENTION_MS = 6 * 60 * 60 * 1000;

export const isTerminal = (status: JobStatus) => status === "completed" || status === "failed";

export function jobSummary(job: Job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    transcriptName: job.input.transcriptName,
    universeName: job.input.universeName,
    playersCount: job.input.playerInfo.filter((p) => (p.role ?? "player") === "player").length,
    error: job.error,
  };
}

/** Oublie les jobs terminés depuis plus de 6 h et supprime leur dossier (audio compris). */
export function cleanupJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (isTerminal(job.status) && now - new Date(job.updatedAt).getTime() > RETENTION_MS) {
      jobs.delete(id);
      rmSync(job.dir, { recursive: true, force: true });
    }
  }
}

export function getJob(id: string): Job | undefined {
  cleanupJobs();
  return jobs.get(id);
}

export function listJobs(statuses: JobStatus[]): Job[] {
  cleanupJobs();
  return [...jobs.values()]
    .filter((job) => !statuses.length || statuses.includes(job.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createJob(input: JobInput): Job {
  cleanupJobs();
  const id = randomUUID();
  const dir = resolve(jobsDir, id);
  mkdirSync(dir, { recursive: true });
  if (input.audioPath) {
    const ext = input.transcriptName.match(AUDIO_EXTENSIONS)?.[0] ?? ".audio";
    const target = resolve(dir, `session${ext}`);
    renameSync(input.audioPath, target);
    input.audioPath = target;
  }
  const now = new Date().toISOString();
  const job: Job = {
    id,
    dir,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    input,
    events: [],
    listeners: new Set(),
    nextEventId: 1,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

export function setStatus(job: Job, status: JobStatus, error: string | null = null): void {
  job.status = status;
  job.error = error;
  job.updatedAt = new Date().toISOString();
}

export function publish(job: Job, type: string, data: unknown): void {
  const event: JobEvent = { id: job.nextEventId++, type, data, timestamp: new Date().toISOString() };
  job.events.push(event);
  job.updatedAt = event.timestamp;
  for (const listener of [...job.listeners]) listener(event);
}

/** Rejoue les événements depuis fromEventId puis suit le job jusqu'à sa fin. */
export function streamJob(req: Request, res: Response, job: Job, fromEventId = 0): void {
  initSSE(res);
  for (const event of job.events) {
    if (event.id >= fromEventId) writeSSEEvent(res, event.type, event.data, event.id);
  }
  if (isTerminal(job.status)) {
    res.end();
    return;
  }

  let closed = false;
  const listener = (event: JobEvent) => {
    writeSSEEvent(res, event.type, event.data, event.id);
    if (isTerminal(job.status)) close();
  };
  const heartbeat = setInterval(() => res.write(":keepalive\n\n"), 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    job.listeners.delete(listener);
    if (!res.writableEnded) res.end();
  };
  job.listeners.add(listener);
  req.on("close", close);
  res.on("close", close);
}
