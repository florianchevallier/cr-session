/**
 * Types du compte-rendu persisté (reports.workflow_state_json) et des lignes « Table » du formulaire.
 */

export type CastRole = "player" | "gm" | "npc";

/** Une ligne du formulaire « Table » : MJ, joueur et son PJ, ou PNJ récurrent. */
export interface PlayerDraft {
  playerName: string;
  characterName: string;
  role?: CastRole;
  aliases?: string;
  characterDetails?: string;
}

export function parsePlayerDraft(value: unknown): PlayerDraft | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const playerName = typeof o.playerName === "string" ? o.playerName.trim() : "";
  const characterName = typeof o.characterName === "string" ? o.characterName.trim() : "";
  if (!playerName && !characterName) return null;
  return {
    playerName,
    characterName,
    role: o.role === "gm" || o.role === "npc" ? o.role : "player",
    aliases: typeof o.aliases === "string" && o.aliases.trim() ? o.aliases.trim() : undefined,
    characterDetails:
      typeof o.characterDetails === "string" && o.characterDetails.trim() ? o.characterDetails.trim() : undefined,
  };
}

export interface SceneMeta {
  id: number;
  title: string;
  startLine: number;
  endLine: number;
  type: string;
  location?: string;
  summary?: string;
  /** Événements du registre qui composent ce chapitre (absent sur les anciens rapports). */
  eventIds?: string[];
}

export interface DiceRoll {
  character: string;
  skill: string;
  result: string;
  context: string;
}

export interface SceneSummary {
  sceneId: number;
  narrativeSummary: string;
  keyEvents: string[];
  diceRolls: DiceRoll[];
  npcsInvolved: string[];
  technicalNotes?: string[];
}

export interface ReportEntities {
  pcs: { name: string; player: string; description?: string }[];
  npcs: { name: string; role?: string; description?: string }[];
  locations: string[];
  items: string[];
}

/** Ce qu'il faut pour (re)construire le markdown d'un compte-rendu. */
export interface ReportState {
  nameDictionary?: import("../pipeline/name-dictionary.js").NameDictionary;
  universeName: string;
  sessionTitle?: string;
  playerInfo: { playerName: string; characterName: string }[];
  scenes: SceneMeta[];
  sceneSummaries: SceneSummary[];
  entities: ReportEntities;
}
