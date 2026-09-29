/**
 * Fiche de casting : qui est autour de la table, qui joue quoi, quels PNJ reviennent.
 * Construite depuis les lignes du formulaire joueurs (rôle joueur / MJ / PNJ).
 */

export type CastRole = "player" | "gm" | "npc";

export interface CastRow {
  playerName: string;
  characterName: string;
  role?: CastRole;
  aliases?: string;
  characterDetails?: string;
  speakerHint?: string;
}

export interface CastSheet {
  gm: { playerName: string };
  players: { playerName: string; characterName: string; aliases?: string[]; details?: string }[];
  recurringNpcs: string[];
  neverConfuse: string[][];
}

export function splitAliases(value?: string): string[] {
  return (value ?? "")
    .split(/[,;/|]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

const tokens = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

/** Paires de noms qui partagent un mot (ex. « Stan » / « Ekila Stan ») : risque de confusion. */
export function findConfusableNames(names: string[]): string[][] {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const pairs: string[][] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = new Set(tokens(unique[i]));
      if (tokens(unique[j]).some((t) => a.has(t))) pairs.push([unique[i], unique[j]]);
    }
  }
  return pairs;
}

export function buildCastSheet(rows: CastRow[]): CastSheet {
  const gmRow = rows.find((r) => r.role === "gm");
  const players = rows
    .filter((r) => (r.role ?? "player") === "player" && r.characterName.trim())
    .map((r) => ({
      playerName: r.playerName.trim() || "?",
      characterName: r.characterName.trim(),
      aliases: splitAliases(r.aliases),
      details: r.characterDetails?.trim() || undefined,
    }));
  const npcRows = rows.filter((r) => r.role === "npc" && (r.characterName.trim() || r.playerName.trim()));
  const recurringNpcs = npcRows.map((r) => {
    const name = r.characterName.trim() || r.playerName.trim();
    const aliases = splitAliases(r.aliases);
    const alias = aliases.length ? ` (${aliases.join(", ")})` : "";
    return `${name}${alias}${r.characterDetails?.trim() ? ` — ${r.characterDetails.trim()}` : ""}`;
  });
  const allNames = [
    ...players.flatMap((p) => [p.characterName, ...(p.aliases ?? [])]),
    ...npcRows.map((r) => r.characterName.trim() || r.playerName.trim()),
  ];
  return {
    gm: { playerName: gmRow?.playerName.trim() || gmRow?.characterName.trim() || "MJ" },
    players,
    recurringNpcs,
    neverConfuse: findConfusableNames(allNames),
  };
}

/** Personnes réelles autour de la table (MJ + joueurs), pour contraindre l'identification des voix. */
export function castPeople(cast: CastSheet): string[] {
  return [...new Set([cast.gm.playerName, ...cast.players.map((p) => p.playerName)])];
}

export function castText(cast: CastSheet): string {
  const lines = cast.players.map((p) => {
    const byGm = p.playerName === cast.gm.playerName ? " — ce PJ est joué par le MJ" : "";
    const aliases = p.aliases?.length ? ` (alias : ${p.aliases.join(", ")})` : "";
    return `- ${p.characterName}${aliases} : PJ joué par ${p.playerName}${byGm}. ${p.details ?? ""}`;
  });
  return [
    `MJ : ${cast.gm.playerName}. Il narre le monde et joue TOUS les PNJ.`,
    `Personnages joueurs :\n${lines.join("\n")}`,
    cast.recurringNpcs.length ? `PNJ récurrents connus :\n${cast.recurringNpcs.map((n) => `- ${n}`).join("\n")}` : "",
    cast.neverConfuse.length ? `Ne jamais confondre : ${cast.neverConfuse.map((g) => g.join(" ≠ ")).join(" ; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt initial WhisperX : noms propres à bien orthographier (max 1000 caractères). */
export function whisperInitialPrompt(cast: CastSheet, universeName: string): string {
  const names = [
    ...cast.players.flatMap((p) => [p.characterName, ...(p.aliases ?? [])]),
    ...cast.recurringNpcs.map((n) => n.split(" — ")[0]),
  ];
  return `Partie de jeu de rôle (${universeName}). Personnages : ${[...new Set(names)].join(", ")}.`.slice(0, 1000);
}

/** Nombre de voix distinctes attendues à la table. */
export function expectedSpeakers(cast: CastSheet): number {
  return Math.max(2, castPeople(cast).filter((p) => p && p !== "?").length);
}
