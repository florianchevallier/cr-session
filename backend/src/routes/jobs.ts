/**
 * Traitements : création (audio ou transcript), suivi SSE, revue des attributions, écoute d'extraits.
 */
import { Router, type Request, type Response } from "express";
import { existsSync, readFileSync, rmSync } from "fs";
import { bodyString, isAudioUpload, upload, uploadName } from "../lib/http.js";
import { errorMessage } from "../lib/log.js";
import type { ReviewDecision } from "../pipeline/ledger-pipeline.js";
import { saveVoiceprintClip } from "../pipeline/voiceprint-store.js";
import { parsePlayerDraft, type PlayerDraft } from "../report/types.js";
import { streamAudioSegment } from "../tools/audio-windows.js";
import { runJob, tablePeople } from "../jobs/runner.js";
import {
  JOB_STATUSES,
  createJob,
  getJob,
  jobSummary,
  listJobs,
  setStatus,
  streamJob,
  type JobInput,
  type JobStatus,
} from "../jobs/store.js";
import { takeCompletedUpload } from "./uploads.js";
import { voiceprintView } from "./voiceprints.js";
import { safeUniverseId } from "./universes.js";

export const jobsRouter = Router();

type Parsed = { ok: true; input: JobInput } | { ok: false; status: number; message: string };

function parseJobRequest(req: Request): Parsed {
  // Enregistrement envoyé par morceaux (/api/uploads) : il remplace le fichier multipart.
  const uploadId = bodyString(req.body?.uploadId);
  let chunked: { path: string; fileName: string } | null = null;
  if (uploadId) {
    const taken = takeCompletedUpload(uploadId);
    if ("error" in taken) return { ok: false, status: 400, message: taken.error };
    chunked = taken;
  }
  const audio = !!chunked || isAudioUpload(req.file);
  const rawTranscript = req.file
    ? audio
      ? ""
      : readFileSync(req.file.path, "utf-8")
    : typeof req.body?.transcript === "string"
      ? req.body.transcript
      : "";
  if (!audio && !rawTranscript.trim()) {
    return { ok: false, status: 400, message: "Aucun enregistrement ni transcript fourni." };
  }

  let rows: unknown = req.body?.playerInfo ?? [];
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      return { ok: false, status: 400, message: "playerInfo invalide (JSON attendu)." };
    }
  }
  if (!Array.isArray(rows)) return { ok: false, status: 400, message: "playerInfo invalide (tableau attendu)." };

  return {
    ok: true,
    input: {
      rawTranscript,
      audioPath: chunked ? chunked.path : audio ? req.file!.path : undefined,
      skipReview: req.body?.skipReview === "true" || req.body?.skipReview === true,
      transcriptName:
        chunked?.fileName ||
        (req.file ? uploadName(req.file).trim() : "") ||
        bodyString(req.body?.transcriptName) ||
        "transcript.txt",
      universeContext: typeof req.body?.universeContext === "string" ? req.body.universeContext : "",
      sessionHistory: typeof req.body?.sessionHistory === "string" ? req.body.sessionHistory : "",
      universeName: bodyString(req.body?.universeName) || "generic",
      playerInfo: rows.map(parsePlayerDraft).filter((p): p is PlayerDraft => p !== null),
    },
  };
}

jobsRouter.post("/", upload.single("transcript"), (req, res) => {
  const parsed = parseJobRequest(req);
  // Un transcript texte a été lu en mémoire, un audio refusé ne sert plus : le fichier temporaire part.
  // Un audio accepté est déplacé dans le dossier du job par createJob.
  if (req.file && (!parsed.ok || !parsed.input.audioPath)) rmSync(req.file.path, { force: true });
  if (!parsed.ok) return void res.status(parsed.status).json({ message: parsed.message });

  const job = createJob(parsed.input);
  void runJob(job);
  res.status(202).json(jobSummary(job));
});

jobsRouter.get("/", (req, res) => {
  const requested = (typeof req.query.status === "string" ? req.query.status : "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is JobStatus => JOB_STATUSES.includes(s as JobStatus));
  res.json(listJobs(requested).map(jobSummary));
});

jobsRouter.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ message: "Traitement introuvable." });
  res.json(jobSummary(job));
});

jobsRouter.get("/:id/stream", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ message: "Traitement introuvable." });
  const from = Number.parseInt(typeof req.query.from === "string" ? req.query.from : "0", 10);
  streamJob(req, res, job, Number.isFinite(from) && from >= 0 ? from : 0);
});

// ── Revue des attributions incertaines ───────────────────────────────────────

jobsRouter.get("/:id/review", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ message: "Traitement introuvable." });
  if (!job.review) return void res.status(409).json({ message: "Aucune revue en attente pour ce traitement." });
  res.json({
    jobId: job.id,
    items: job.review.items,
    candidates: job.review.candidates,
    people: tablePeople(job),
    hasAudio: !!job.input.audioPath,
  });
});

jobsRouter.post("/:id/review", (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.review) return void res.status(409).json({ message: "Aucune revue en attente pour ce traitement." });
  const known = new Set(job.review.items.map((i) => i.eventId));
  const raw: unknown[] = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
  const decisions: ReviewDecision[] = raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .filter((d) => typeof d.eventId === "string" && known.has(d.eventId))
    .map((d) => ({
      eventId: d.eventId as string,
      actor: typeof d.actor === "string" && d.actor.trim() ? d.actor.trim() : undefined,
      drop: d.drop === true,
    }));
  const { resolve: resolveReview } = job.review;
  job.review = undefined;
  setStatus(job, "running");
  resolveReview(decisions);
  res.json({ accepted: decisions.length });
});

// ── Audio d'un job ───────────────────────────────────────────────────────────

const jobAudio = (id: string) => {
  const job = getJob(id);
  const path = job?.playableAudioPath ?? job?.input.audioPath;
  return job && path && existsSync(path) ? { job, path } : null;
};

export function sendAudioSegment(res: Response, path: string, startParam: unknown, endParam: unknown): void {
  const start = Number(startParam);
  const end = Number(endParam);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 600) {
    res.status(400).json({ message: "Intervalle invalide (start < end, 10 min max)." });
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  const ff = streamAudioSegment(path, start, end);
  ff.stdout.pipe(res);
  ff.on("error", () => res.end());
  res.on("close", () => ff.kill("SIGKILL"));
}

jobsRouter.get("/:id/audio", (req, res) => {
  const found = jobAudio(req.params.id);
  if (!found) return void res.status(404).json({ message: "Aucun audio pour ce traitement." });
  sendAudioSegment(res, found.path, req.query.start, req.query.end);
});

/** Crée un échantillon de voix (validé) à partir d'un extrait, depuis la revue. */
jobsRouter.post("/:id/voiceprints", async (req, res) => {
  const found = jobAudio(req.params.id);
  const universeId = found ? safeUniverseId(found.job.input.universeName) : null;
  if (!found || !universeId) return void res.status(404).json({ message: "Aucun audio pour ce traitement." });
  const personName = bodyString(req.body?.personName);
  const start = Number(req.body?.start);
  const end = Number(req.body?.end);
  if (!personName || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return void res.status(400).json({ message: "Personne et intervalle valides requis." });
  }
  try {
    const saved = await saveVoiceprintClip({
      universeId,
      personName,
      audioPath: found.path,
      start,
      end,
      source: `${found.job.input.transcriptName} @${Math.round(start)}s`,
    });
    res.status(201).json(voiceprintView(saved));
  } catch (err) {
    res.status(500).json({ message: errorMessage(err, "Échantillon impossible à enregistrer.") });
  }
});
