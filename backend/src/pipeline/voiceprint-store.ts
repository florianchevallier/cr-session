/**
 * Stockage des échantillons de voix : fichiers MP3 dans data/voiceprints + ligne en base.
 */
import { mkdirSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { dataDir, insertVoiceprint, listVoiceprints, getVoiceprint, type VoiceprintRow } from "../config/database.js";
import { cutAudio } from "../tools/audio-windows.js";
import type { VoiceClipSuggestion } from "./voice-suggestions.js";

export const voiceprintsDir = resolve(dataDir, "voiceprints");
mkdirSync(voiceprintsDir, { recursive: true });

export const MAX_VOICEPRINT_SEC = 30;

export async function saveVoiceprintClip(opts: {
  universeId: string;
  personName: string;
  audioPath: string;
  start: number;
  end: number;
  source: string;
  status?: "confirmed" | "pending";
}): Promise<VoiceprintRow> {
  const id = randomUUID();
  const clipPath = resolve(voiceprintsDir, `${id}.mp3`);
  const end = Math.min(opts.end, opts.start + MAX_VOICEPRINT_SEC);
  await cutAudio(opts.audioPath, opts.start, end, clipPath);
  insertVoiceprint({
    id,
    universeId: opts.universeId,
    personName: opts.personName,
    clipPath,
    durationSec: end - opts.start,
    source: opts.source,
    status: opts.status ?? "confirmed",
  });
  return getVoiceprint(id)!;
}

/**
 * Enregistre les extraits proposés comme échantillons « à vérifier », uniquement pour les personnes
 * qui n'ont encore aucun échantillon (validé ou proposé) dans cet univers.
 */
export async function proposeVoiceprints(
  universeId: string,
  audioPath: string,
  suggestions: VoiceClipSuggestion[],
  sourceName: string
): Promise<VoiceprintRow[]> {
  const covered = new Set(listVoiceprints(universeId).map((v) => v.personName.toLowerCase()));
  const created: VoiceprintRow[] = [];
  for (const s of suggestions) {
    if (covered.has(s.person.toLowerCase())) continue;
    created.push(
      await saveVoiceprintClip({
        universeId,
        personName: s.person,
        audioPath,
        start: s.start,
        end: s.end,
        source: `proposé depuis ${sourceName} @${Math.round(s.start)}s : « ${s.text.slice(0, 80)} »`,
        status: "pending",
      })
    );
  }
  return created;
}
