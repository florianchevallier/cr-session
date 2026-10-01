/**
 * Exécution d'un job « registre » : transcription éventuelle, analyse, revue humaine
 * des attributions incertaines, rédaction. Indépendant d'Express : le serveur fournit
 * les callbacks de publication d'événements et de persistance.
 */
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { transcribeFile } from "../tools/transcription-client.js";
import { parseTranscriptInput, type SessionTranscript } from "../tools/transcript-input.js";
import { transcodeForGemini } from "../tools/audio-windows.js";
import { buildCastSheet, expectedSpeakers, whisperInitialPrompt, type CastRow } from "./cast.js";
import { validateDictionary, type NameDictionary, type NameEvidence } from "./name-dictionary.js";
import {
  analyzeSession,
  applyReview,
  reviewItems,
  writeSession,
  type LedgerPipelineInput,
  type ReviewDecision,
  type ReviewItem,
  type SessionOutput,
  type VoiceSample,
} from "./ledger-pipeline.js";

export interface LedgerJobInput {
  jobDir: string;
  /** Audio de la séance (déjà sur disque) ou transcript texte/JSON. */
  audioPath?: string;
  transcriptText?: string;
  players: CastRow[];
  universeName: string;
  universeContext: string;
  sessionHistory: string;
  voiceSamples: VoiceSample[];
  /** Désactive la pause de revue (ex. appels API sans interface). */
  skipReview?: boolean;
}

export interface LedgerJobHooks {
  step: (step: string, label: string, status: "start" | "complete", data?: Record<string, unknown>) => void;
  progress: (step: string, label: string) => void;
  /** Audio converti prêt : il peut servir à l'écoute des extraits pendant la revue. */
  onAudioReady?: (path: string) => void;
  /** Publie les éléments à revoir et attend les décisions de l'utilisateur. */
  review: (items: ReviewItem[], candidates: string[], names: NameDictionary, evidence: NameEvidence[]) => Promise<ReviewResponse>;
}

export interface ReviewResponse { decisions: ReviewDecision[]; nameDictionary?: NameDictionary }

export interface LedgerJobResult extends SessionOutput {
  rawTranscript: string;
  /** Audio converti (mp3 16 kHz), réutilisable pour l'écoute et les échantillons de voix. */
  playableAudioPath?: string;
}

const STEP_LABELS: Record<string, string> = {
  transcribe: "Transcription de l'audio (WhisperX)",
  voices: "Identification des voix",
  ledger: "Registre des événements",
  consolidate: "Consolidation de la séance",
  review: "Vérification des attributions incertaines",
  write: "Rédaction des chapitres",
  format: "Mise en forme du compte-rendu",
};

export async function runLedgerJob(input: LedgerJobInput, hooks: LedgerJobHooks): Promise<LedgerJobResult> {
  const cast = buildCastSheet(input.players);
  let transcript: SessionTranscript;
  let rawTranscript: string;
  let playableAudioPath: string | undefined;

  if (input.audioPath) {
    hooks.step("transcribe", STEP_LABELS.transcribe, "start");
    playableAudioPath = await transcodeForGemini(input.audioPath, resolve(input.jobDir, "session.16k.mp3"));
    hooks.onAudioReady?.(playableAudioPath);
    const whisper = await transcribeFile(playableAudioPath, {
      nbSpeaker: expectedSpeakers(cast),
      initialPrompt: whisperInitialPrompt(cast, input.universeName),
      onProgress: (m) => hooks.progress("transcribe", `${STEP_LABELS.transcribe} — ${m.replace(/^\[[^\]]+\]\s*/, "")}`),
    });
    rawTranscript = JSON.stringify(whisper);
    await writeFile(resolve(input.jobDir, "whisperx.json"), rawTranscript);
    transcript = { ...whisper, timed: true };
    hooks.step("transcribe", `${STEP_LABELS.transcribe} — ${whisper.segments.length} segments`, "complete");
  } else {
    rawTranscript = input.transcriptText ?? (await readFile(resolve(input.jobDir, "transcript.txt"), "utf-8"));
    transcript = parseTranscriptInput(rawTranscript);
  }
  if (!transcript.segments.length) throw new Error("Transcript vide ou illisible.");

  const pipelineInput: LedgerPipelineInput = {
    whisper: transcript,
    timed: transcript.timed,
    audioPath: playableAudioPath,
    voiceSamples: playableAudioPath ? input.voiceSamples : [],
    cast,
    universeName: input.universeName,
    universeContext: input.universeContext,
    sessionHistory: input.sessionHistory,
    cacheDir: resolve(input.jobDir, "cache"),
    onProgress: (step, detail) => {
      switch (step) {
        case "voices":
          hooks.step("voices", STEP_LABELS.voices, "start");
          break;
        case "voices:done":
          hooks.step("voices", `${STEP_LABELS.voices} — ${(detail?.voices as string[] | undefined)?.join(", ") ?? ""}`, "complete");
          hooks.step("ledger", STEP_LABELS.ledger, "start");
          break;
        case "window":
          hooks.progress("ledger", `${STEP_LABELS.ledger} — extrait ${Number(detail?.index) + 1}/${detail?.of}`);
          break;
        case "ledger:done":
          hooks.step("ledger", `${STEP_LABELS.ledger} — ${detail?.events} événements`, "complete");
          break;
        case "consolidate":
          hooks.step("consolidate", STEP_LABELS.consolidate, "start");
          break;
        case "consolidate:done":
          hooks.step("consolidate", `${STEP_LABELS.consolidate} — ${detail?.chapters} chapitres`, "complete");
          break;
        case "write":
          hooks.progress("write", `${STEP_LABELS.write} — chapitre ${detail?.chapter}/${detail?.of} : ${detail?.title ?? ""}`);
          break;
        case "rewrite":
          hooks.progress("write", `${STEP_LABELS.write} — correction du chapitre ${detail?.chapter} (${detail?.issues} points)`);
          break;
        case "names:check":
          hooks.progress("write", "Contrôle global des noms du compte-rendu");
          break;
        case "names:done":
          hooks.progress("write", `Contrôle global des noms — ${detail?.warnings} point(s) à revoir`);
          break;
      }
    },
  };

  let analysis = await analyzeSession(pipelineInput);

  const items = input.skipReview ? [] : reviewItems(pipelineInput, analysis);
  if (!input.skipReview && (items.length || analysis.nameDictionary?.length)) {
    hooks.step("review", `${STEP_LABELS.review} — ${items.length} à confirmer`, "start");
    const candidates = [
      ...cast.players.map((p) => p.characterName),
      ...cast.recurringNpcs.map((n) => n.split(" — ")[0].replace(/\s*\(.*\)$/, "")),
    ];
    const evidence = analysis.events.map((e) => ({ eventId: e.id,
      text: `${e.actor} : ${e.action}\n` + e.segIds.map((id) => transcript.segments[id]?.text.trim()).filter(Boolean).join("\n"),
      start: Math.max(0, e.t - 3), end: Math.max(e.t + 6, ...e.segIds.map((id) => transcript.segments[id]?.end ?? e.t)) + 3 }));
    const response = await hooks.review(items, [...new Set([...candidates, ...(analysis.nameDictionary ?? []).map((e) => e.canonical)])], analysis.nameDictionary ?? [], evidence);
    const { decisions } = response;
    analysis = applyReview(analysis, decisions);
    if (response.nameDictionary) analysis.nameDictionary = validateDictionary(response.nameDictionary);
    await writeFile(resolve(input.jobDir, "cache", "human-review.json"), JSON.stringify(response, null, 2));
    const changed = decisions.filter((d) => d.actor || d.drop).length;
    hooks.step("review", `${STEP_LABELS.review} — ${changed} correction(s)`, "complete", { decisions });
  }

  hooks.step("write", STEP_LABELS.write, "start");
  const output = await writeSession(pipelineInput, analysis);
  hooks.step("write", STEP_LABELS.write, "complete");

  return { ...output, rawTranscript, playableAudioPath };
}
