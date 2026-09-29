/**
 * Outils partagés du banc d'évaluation d'attribution.
 */
import { readFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";
import type { WhisperResult } from "../src/tools/transcription-client.js";

export const EVAL_DIR = fileURLToPath(new URL(".", import.meta.url));
export const DATA_DIR = resolve(EVAL_DIR, "data");
export const RESULTS_DIR = resolve(EVAL_DIR, "data/results");

export interface CastPlayer {
  playerName: string;
  characterName: string;
  aliases?: string[];
  details?: string;
}

export interface Cast {
  sessionId: string;
  audio: string;
  gm: { playerName: string };
  players: CastPlayer[];
  recurringNpcs: string[];
  neverConfuse: string[][];
  previousSessionSummary?: string;
}

export async function loadCast(session = "mage-session"): Promise<Cast> {
  return JSON.parse(await readFile(resolve(DATA_DIR, `${session}.cast.json`), "utf-8"));
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(process.env.HOME ?? "", p.slice(2)) : p;
}

export async function loadWhisper(session = "mage-session"): Promise<WhisperResult> {
  return JSON.parse(await readFile(resolve(DATA_DIR, `${session}.whisperx.json`), "utf-8"));
}

export function castAsText(cast: Cast): string {
  const players = cast.players
    .map((p) => {
      const role = p.playerName === cast.gm.playerName ? " — joué par le MJ" : "";
      const aliases = p.aliases?.length ? ` (alias : ${p.aliases.join(", ")})` : "";
      return `- ${p.characterName}${aliases} : PJ joué par ${p.playerName}${role}. ${p.details ?? ""}`;
    })
    .join("\n");
  return [
    `MJ : ${cast.gm.playerName} (narre et joue tous les PNJ).`,
    `Personnages joueurs :\n${players}`,
    `PNJ récurrents connus :\n${cast.recurringNpcs.map((n) => `- ${n}`).join("\n")}`,
    cast.neverConfuse.length
      ? `Ne jamais confondre : ${cast.neverConfuse.map((g) => g.join(" ≠ ")).join(" ; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
