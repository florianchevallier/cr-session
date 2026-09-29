/**
 * Exécute un job : pipeline registre, pause de revue, sauvegarde du rapport, coût,
 * proposition d'échantillons de voix.
 */
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { insertReport, listVoiceprints } from "../config/database.js";
import { trackUsage, type UsageReport } from "../config/genai.js";
import { errorMessage, log } from "../lib/log.js";
import { runLedgerJob } from "../pipeline/ledger-job.js";
import type { ReviewDecision, VoiceSample } from "../pipeline/ledger-pipeline.js";
import { suggestVoiceClips } from "../pipeline/voice-suggestions.js";
import { proposeVoiceprints } from "../pipeline/voiceprint-store.js";
import { safeUniverseId } from "../routes/universes.js";
import { cleanupJobs, publish, setStatus, type Job } from "./store.js";

/** Personnes réelles à la table (MJ et joueurs), sans les PNJ. */
export function tablePeople(job: Job): string[] {
  return [
    ...new Set(job.input.playerInfo.filter((p) => p.role !== "npc").map((p) => p.playerName).filter(Boolean)),
  ];
}

function formatUsd(value: number): string {
  return `${value.toFixed(value < 1 ? 3 : 2)} $`;
}

/** Coût persisté avec le rapport. La transcription WhisperX (serveur perso) est gratuite. */
function costSummary(usage: UsageReport) {
  return {
    costUsd: Number(usage.costUsd.toFixed(4)),
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    unpricedModels: usage.unpricedModels,
    byTask: usage.byTask,
    measuredAt: new Date().toISOString(),
  };
}

/** Échantillons validés à l'oreille pour cet univers : le plus récent par personne. */
function voiceSamplesFor(universeName: string, people: string[]): VoiceSample[] {
  const universeId = safeUniverseId(universeName);
  if (!universeId) return [];
  const wanted = new Set(people.map((p) => p.toLowerCase()));
  const seen = new Set<string>();
  const samples: VoiceSample[] = [];
  for (const v of listVoiceprints(universeId)) {
    const key = v.personName.trim().toLowerCase();
    if (v.status !== "confirmed" || !wanted.has(key) || seen.has(key) || !existsSync(v.clipPath)) continue;
    seen.add(key);
    samples.push({ person: v.personName, path: v.clipPath });
  }
  return samples;
}

/** Propose des échantillons « à vérifier » pour les personnes qui n'en ont pas encore. */
async function proposeVoiceprintsFromJob(
  job: Job,
  result: { rawTranscript: string; playableAudioPath?: string; workflowState: Record<string, unknown> }
): Promise<void> {
  const universeId = safeUniverseId(job.input.universeName);
  const ledger = result.workflowState.ledger as
    | { voiceMap?: Parameters<typeof suggestVoiceClips>[1]; speakerCorrections?: { segId: number }[] }
    | undefined;
  if (!universeId || !result.playableAudioPath || !ledger?.voiceMap) return;
  try {
    const segments = JSON.parse(result.rawTranscript).segments ?? [];
    const suggestions = suggestVoiceClips(segments, ledger.voiceMap, ledger.speakerCorrections ?? [], tablePeople(job));
    const created = await proposeVoiceprints(universeId, result.playableAudioPath, suggestions, job.input.transcriptName);
    if (created.length) log("Échantillons de voix proposés", { jobId: job.id, people: created.map((c) => c.personName) });
  } catch (err) {
    log("Proposition d'échantillons de voix impossible", { jobId: job.id, error: errorMessage(err) });
  }
}

export async function runJob(job: Job): Promise<void> {
  const { input } = job;
  setStatus(job, "running");
  log("Démarrage du traitement", {
    jobId: job.id,
    audio: !!input.audioPath,
    transcriptLength: input.rawTranscript.length,
    universe: input.universeName,
    rows: input.playerInfo.length,
  });

  try {
    const people = tablePeople(job);
    const { result, usage } = await trackUsage(() =>
      runLedgerJob(
        {
          jobDir: job.dir,
          audioPath: input.audioPath,
          transcriptText: input.audioPath ? undefined : input.rawTranscript,
          players: input.playerInfo,
          universeName: input.universeName,
          universeContext: input.universeContext,
          sessionHistory: input.sessionHistory,
          voiceSamples: voiceSamplesFor(input.universeName, people),
          skipReview: input.skipReview,
        },
        {
          step: (step, label, status, data) =>
            publish(job, status === "start" ? "step:start" : "step:complete", { step, label, data }),
          progress: (step, label) => publish(job, "step:progress", { step, label }),
          onAudioReady: (path) => {
            job.playableAudioPath = path;
          },
          review: (items, candidates) =>
            new Promise<ReviewDecision[]>((resolveReview) => {
              job.review = { items, candidates, resolve: resolveReview };
              setStatus(job, "review");
              publish(job, "review", { jobId: job.id, items, candidates, people, hasAudio: !!input.audioPath });
            }),
        }
      )
    );

    const cost = costSummary(usage);
    log("Coût Gemini du traitement", { jobId: job.id, ...cost });
    publish(job, "step:complete", {
      step: "format",
      label: `Compte-rendu généré ! Coût Gemini ≈ ${formatUsd(cost.costUsd)} (${cost.calls} appels)`,
      data: { cost },
    });
    await proposeVoiceprintsFromJob(job, result);

    const reportId = randomUUID();
    insertReport({
      id: reportId,
      jobId: job.id,
      reportMd: result.report,
      universeName: input.universeName,
      transcriptName: input.transcriptName,
      players: input.playerInfo,
      workflowState: { ...result.workflowState, playerInfo: input.playerInfo, universeName: input.universeName, cost },
      rawTranscript: result.rawTranscript,
      preprocessedTranscript: result.preprocessedTranscript,
      universeContext: input.universeContext || null,
      sessionHistory: input.sessionHistory || null,
    });
    log("Rapport enregistré", { reportId, jobId: job.id });

    publish(job, "result", {
      reportId,
      cost,
      finalReport: result.report,
      scenes: result.workflowState.scenes,
      entities: result.workflowState.entities,
      job: {
        id: job.id,
        universeName: input.universeName,
        transcriptName: input.transcriptName,
        playerInfo: input.playerInfo,
      },
    });
    setStatus(job, "completed");
    publish(job, "done", { message: "Traitement terminé." });
  } catch (error) {
    const message = errorMessage(error);
    setStatus(job, "failed", message);
    log("Traitement en erreur", { jobId: job.id, message });
    console.error("Erreur de traitement :", error);
    publish(job, "error", {
      message,
      stack: process.env.NODE_ENV === "development" && error instanceof Error ? error.stack : undefined,
    });
  } finally {
    job.review = undefined;
    cleanupJobs();
  }
}
