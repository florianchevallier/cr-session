import { nameNormalizer } from "../pipeline/name-dictionary.js";
import type { ReportState } from "./types.js";
import type { NameDictionary } from "../pipeline/name-dictionary.js";

export function normalizeReportMarkdown(markdown: string, dictionary: NameDictionary): string {
  const n = nameNormalizer(dictionary);
  let inCastTable = false;
  return markdown.split("\n").map((line) => {
    if (/^\|\s*Joueur\s*\|\s*Personnage\s*\|/i.test(line)) { inCastTable = true; return line; }
    if (inCastTable && !line.startsWith("|")) inCastTable = false;
    if (inCastTable) return line.replace(/^(\|[^|]*\|)([^|]*)(\|.*)$/, (_match, player, character, rest) => player + n(character) + rest);
    return n(line);
  }).join("\n");
}

/** Normalize only fictional content; real player names and source records are untouched. */
export function normalizeReportState<T extends ReportState>(state: T): T {
  const n = nameNormalizer(state.nameDictionary ?? []);
  const optional = (s?: string) => s === undefined ? undefined : n(s);
  return { ...state, sessionTitle: optional(state.sessionTitle),
    playerInfo: state.playerInfo.map((p) => ({ ...p, characterName: n(p.characterName) })),
    scenes: state.scenes.map((s) => ({ ...s, title: n(s.title), location: optional(s.location), summary: optional(s.summary) })),
    sceneSummaries: state.sceneSummaries.map((s) => ({ ...s, narrativeSummary: n(s.narrativeSummary),
      keyEvents: s.keyEvents.map(n), npcsInvolved: [...new Set(s.npcsInvolved.map(n))], technicalNotes: s.technicalNotes?.map(n),
      diceRolls: s.diceRolls.map((r) => ({ ...r, character: n(r.character), skill: n(r.skill), context: n(r.context) })) })),
    entities: { ...state.entities,
      pcs: state.entities.pcs.map((p) => ({ ...p, name: n(p.name), description: optional(p.description) })),
      npcs: [...new Map(state.entities.npcs.map((p) => { const name = n(p.name); return [name, { ...p, name, role: optional(p.role), description: optional(p.description) }] as const; })).values()],
      locations: [...new Set(state.entities.locations.map(n))], items: state.entities.items.map(n),
    },
  };
}
