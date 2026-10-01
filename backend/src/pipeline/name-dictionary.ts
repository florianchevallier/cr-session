import { z } from "zod/v4";
import type { CastSheet } from "./cast.js";
import type { LedgerEvent } from "./ledger-schemas.js";

export const NameEntrySchema = z.object({
  id: z.string().min(1),
  canonical: z.string().trim().min(1).max(120),
  kind: z.enum(["PJ", "PNJ"]),
  status: z.enum(["proposed", "confirmed"]),
  assignedEventIds: z.array(z.string()).optional(),
  aliases: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["transcription", "alias"]),
    status: z.enum(["proposed", "confirmed", "rejected"]),
    reason: z.string(),
    eventIds: z.array(z.string()),
  })),
});
export const NameDictionarySchema = z.array(NameEntrySchema);
export type NameEntry = z.infer<typeof NameEntrySchema>;
export type NameDictionary = NameEntry[];
export interface NameEvidence { eventId: string; text: string; start: number; end: number }

const key = (s: string) => s.normalize("NFC").toLocaleLowerCase("fr").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** No accent/fuzzy matching: identity merges require an explicit decision. */
export function validateDictionary(value: unknown): NameDictionary {
  const dictionary = NameDictionarySchema.parse(value);
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const entry of dictionary) {
    if (ids.has(entry.id)) throw new Error("Deux personnages ont le même identifiant.");
    ids.add(entry.id);
    for (const name of [entry.canonical, ...entry.aliases.filter((a) => a.status === "confirmed").map((a) => a.name)]) {
      const owner = owners.get(key(name));
      if (owner && owner !== entry.id) throw new Error(`« ${name} » appartient à deux personnages. Sépare ou fusionne explicitement ces entrées.`);
      owners.set(key(name), entry.id);
    }
  }
  return dictionary;
}

export function seedDictionary(cast: CastSheet, events: LedgerEvent[], proposed: NameDictionary = []): NameDictionary {
  const entries: NameDictionary = proposed.map((e, i) => ({ ...e, id: `name-${i}`, status: "proposed", assignedEventIds: [],
    aliases: e.aliases.map((a) => ({ ...a, status: "proposed" })) }));
  const knownCharacters = [...cast.players.map((p) => ({ ...p, kind: "PJ" as const })), ...cast.recurringNpcs.map((text) => {
    const name = text.split(" — ")[0];
    return { characterName: name.replace(/\s*\(.*\)$/, ""), aliases: name.match(/\((.*)\)$/)?.[1].split(",").map((s) => s.trim()) ?? [], kind: "PNJ" as const };
  })];
  for (const p of knownCharacters) {
    // User-supplied aliases already settle identity, even if the AI chose one as a canonical name.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (key(entries[i].canonical) !== key(p.characterName) && p.aliases?.some((a) => key(a) === key(entries[i].canonical))) entries.splice(i, 1);
    }
    const entry = entries.find((e) => key(e.canonical) === key(p.characterName));
    const known: NameEntry = { id: entry?.id ?? `cast-${p.kind}-${key(p.characterName)}`, canonical: p.characterName, kind: p.kind, status: "confirmed",
      aliases: (p.aliases ?? []).map((name) => ({ name, kind: "alias", status: "confirmed", reason: "Casting fourni par l'utilisateur", eventIds: [] })) };
    if (entry) Object.assign(entry, known); else entries.push(known);
  }
  for (const event of events.filter((e) => e.actorType !== "monde")) {
    if (entries.some((e) => key(e.canonical) === key(event.actor) || e.aliases.some((a) => key(a.name) === key(event.actor)))) continue;
    entries.push({ id: `observed-${key(event.actor)}`, canonical: event.actor, kind: event.actorType as "PJ" | "PNJ", status: "proposed", aliases: [] });
  }
  // An AI proposal must never absorb a canonical name explicitly supplied by the human.
  const protectedNames = new Set(knownCharacters.map((p) => key(p.characterName)));
  for (const entry of entries) entry.aliases = entry.aliases.filter((a) => !protectedNames.has(key(a.name)) || key(a.name) === key(entry.canonical));
  return validateDictionary(entries);
}

export function nameNormalizer(dictionary: NameDictionary) {
  const names = new Map<string, string>();
  for (const e of dictionary) {
    names.set(key(e.canonical), e.canonical);
    for (const a of e.aliases) if (a.status === "confirmed") names.set(key(a.name), e.canonical);
  }
  if (!names.size) return (text: string) => text;
  // Longest first protects Ekila Stan from the shorter name Stan. One pass avoids chains.
  const pattern = [...names.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "giu");
  return (text: string) => text.replace(regex, (match) => names.get(key(match)) ?? match);
}

export function normalizeEvents(events: LedgerEvent[], dictionary: NameDictionary): LedgerEvent[] {
  const normalize = nameNormalizer(dictionary);
  const assignments = new Map(dictionary.flatMap((n) => (n.assignedEventIds ?? []).map((id) => [id, n] as const)));
  return events.map((e) => {
    const assigned = assignments.get(e.id);
    const local = assigned ? nameNormalizer([...dictionary, { ...assigned, aliases: [...assigned.aliases,
      { name: e.actor, kind: "alias", status: "confirmed", reason: "Occurrence réattribuée par l'humain", eventIds: [e.id] }] }]) : normalize;
    return { ...e, actorId: assigned?.id ?? dictionary.find((n) => key(n.canonical) === key(normalize(e.actor)))?.id,
      actor: assigned?.canonical ?? normalize(e.actor), actorType: assigned?.kind ?? e.actorType, action: local(e.action), quote: normalize(e.quote),
      location: normalize(e.location), present: e.present.map(normalize), roll: e.roll ? { ...e.roll, traits: normalize(e.roll.traits) } : null };
  });
}

export function validateNameReview(value: unknown, original: NameDictionary, eventIds: Set<string>): NameDictionary {
  const next = validateDictionary(value);
  const assigned = new Set<string>();
  for (const e of next) for (const id of e.assignedEventIds ?? []) {
    if (!eventIds.has(id) || assigned.has(id)) throw new Error("Une occurrence est inconnue ou attribuée à deux personnages.");
    assigned.add(id);
  }
  return next;
}

export function dictionaryText(dictionary: NameDictionary = []): string {
  return "NOMS DES PERSONNAGES (les décisions humaines font foi ; n'invente aucune variante) :\n" + dictionary.map((e) =>
    `- ${e.id} : ${e.canonical} (${e.kind}). Variantes validées : ${e.aliases.filter((a) => a.status === "confirmed").map((a) => a.name).join(", ") || "aucune"}. ` +
    `Rapprochements NON validés, à ne pas appliquer : ${e.aliases.filter((a) => a.status !== "confirmed").map((a) => a.name).join(", ") || "aucun"}.`
  ).join("\n");
}
