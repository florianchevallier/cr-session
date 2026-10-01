import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCastSheet } from "./cast.js";
import { nameNormalizer, normalizeEvents, seedDictionary, validateDictionary, validateNameReview, type NameDictionary } from "./name-dictionary.js";
import { normalizeReportState } from "../report/names.js";
import { formatReport } from "../report/formatter.js";
import { reportNames, updateReportNames, type StoredReport } from "../report/editing.js";
import type { LedgerEvent } from "./ledger-schemas.js";
import type { ReportState } from "../report/types.js";

const names: NameDictionary = [
  { id: "z", canonical: "Zéphira", kind: "PNJ", status: "confirmed", aliases: [{ name: "Séphira", kind: "transcription", status: "confirmed", reason: "même personnage", eventIds: ["e1"] }] },
  { id: "g", canonical: "Griffe-Rouge", kind: "PNJ", status: "confirmed", aliases: [] },
  { id: "c", canonical: "Croc Écarlate", kind: "PNJ", status: "confirmed", aliases: [] },
  { id: "s", canonical: "Stan", kind: "PJ", status: "confirmed", aliases: [] },
  { id: "es", canonical: "Ekila Stan", kind: "PJ", status: "confirmed", aliases: [] },
];
const event: LedgerEvent = { id: "e1", t: 12, window: 0, segIds: [1], actor: "Séphira", actorType: "PNJ", spokenBy: "MJ", action: "Séphira aide Ekila Stan.", status: "réussi", roll: null, quote: "Séphira !", location: "Bunker", present: ["Ekila Stan"], confidence: 0.8, evidence: "transcript" };
const state: ReportState = { nameDictionary: names, universeName: "Mage", sessionTitle: "Séphira au bunker",
  playerInfo: [{ playerName: "Séphira", characterName: "Ekila Stan" }],
  scenes: [{ id: 1, title: "Séphira", startLine: 1, endLine: 2, type: "narrative", summary: "Séphira aide Stan.", eventIds: ["e1"] }],
  sceneSummaries: [{ sceneId: 1, narrativeSummary: "Séphira aide Ekila Stan et Griffe-Rouge rejoint Croc Écarlate.", keyEvents: ["Séphira aide Stan"], npcsInvolved: ["Séphira : alliée"], technicalNotes: ["Vie : Séphira est protégée"], diceRolls: [{ character: "Stan", skill: "Vie", result: "5 succès", context: "Renforce Séphira." }] }],
  entities: { pcs: [], npcs: [{ name: "Séphira", role: "Protège Séphira" }, { name: "Zéphira", role: "alliée" }], locations: [], items: [] } };

test("the same dictionary normalizes narrative, synopses, rolls, notes and annexes", () => {
  const normalized = normalizeReportState(state);
  assert.equal(normalized.entities.npcs.length, 1);
  assert.equal(normalized.sceneSummaries[0].diceRolls[0].context, "Renforce Zéphira.");
  const markdown = formatReport(state);
  assert.ok(markdown.includes("Griffe-Rouge rejoint Croc Écarlate"));
  assert.ok(markdown.includes("| Séphira | Ekila Stan |"), "real player name is never transformed");
  assert.equal(markdown.replace("| Séphira | Ekila Stan |", "").includes("Séphira"), false);
  assert.equal(state.sceneSummaries[0].narrativeSummary.startsWith("Séphira"), true, "source remains intact");
});

test("long names and Unicode boundaries are protected; replacements never cascade", () => {
  const dictionary: NameDictionary = [...names, { id: "v", canonical: "Stanislas", kind: "PJ", status: "confirmed", aliases: [{ name: "Stan", kind: "alias", status: "confirmed", reason: "test", eventIds: [] }] }];
  const n = nameNormalizer(dictionary.filter((e) => e.id !== "s"));
  assert.equal(n("Stan, Ekila Stan et Standard. Séphira !"), "Stanislas, Ekila Stan et Standard. Zéphira !");
});

test("proposed and rejected aliases do not merge characters", () => {
  for (const status of ["proposed", "rejected"] as const) {
    const dictionary = names.map((e) => ({ ...e, aliases: e.aliases.map((a) => ({ ...a, status })) }));
    assert.equal(nameNormalizer(dictionary)("Séphira et Zéphira"), "Séphira et Zéphira");
  }
});

test("confirmed aliases cannot swallow another canonical identity", () => {
  assert.throws(() => validateDictionary(names.map((e) => e.id === "g" ? { ...e, aliases: [{ name: "Croc Écarlate", kind: "alias", status: "confirmed", reason: "similar role", eventIds: [] }] } : e)), /deux personnages/);
});

test("human casting protects distinct NPCs against AI proposals", () => {
  const cast = buildCastSheet([{ playerName: "", characterName: "Griffe-Rouge", role: "npc" }, { playerName: "", characterName: "Croc Écarlate", role: "npc" }]);
  const dict = seedDictionary(cast, [], [{ ...names[1], aliases: [{ name: "Croc Écarlate", kind: "alias", status: "proposed", reason: "wrong AI guess", eventIds: [] }] }]);
  assert.equal(dict.length, 2);
  assert.equal(dict[0].aliases.length, 0);
});

test("occurrence assignments remain local and source ledger stays intact", () => {
  const dictionary = names.map((e) => e.id === "c" ? { ...e, assignedEventIds: ["e1"] } : e);
  const events = normalizeEvents([event, { ...event, id: "e2" }], dictionary);
  assert.equal(events[0].actor, "Croc Écarlate");
  assert.equal(events[0].actorId, "c");
  assert.equal(events[0].action, "Croc Écarlate aide Ekila Stan.");
  assert.equal(events[1].actor, "Zéphira");
  assert.equal(event.actor, "Séphira");
  assert.throws(() => validateNameReview(dictionary, names, new Set()), /occurrence/);
});

test("report rename preserves manual Markdown corrections and raw events for regeneration", () => {
  const report: StoredReport = { reportMd: formatReport(state) + "\nCorrection humaine : Zéphira sourit.", players: [], workflowState: { ...normalizeReportState(state), ledger: { events: normalizeEvents([event], names), rawEvents: [event] } }, sessionHistory: null, preprocessedTranscript: null };
  const updated = updateReportNames(report, names.map((e) => e.id === "z" ? { ...e, canonical: "Zefira" } : e));
  assert.ok(updated.reportMd.includes("Correction humaine : Zefira sourit."));
  assert.ok(updated.reportMd.includes("| Séphira | Ekila Stan |"), "report edits also preserve real player names");
  assert.equal((updated.workflowState.ledger as { rawEvents: LedgerEvent[] }).rawEvents[0].actor, "Séphira");
  assert.equal((updated.workflowState.ledger as { events: LedgerEvent[] }).events[0].actor, "Zefira");
  assert.equal(formatReport(updated.workflowState).includes("Zéphira"), false);
});

test("legacy reports without a dictionary can still be opened and edited", () => {
  const report: StoredReport = { reportMd: "Un récit ancien.", players: [], workflowState: null, sessionHistory: null, preprocessedTranscript: null };
  assert.deepEqual(reportNames(report), { nameDictionary: [], evidence: [], warnings: [] });
  assert.equal(updateReportNames(report, []).reportMd, report.reportMd);
});

test("a split can restore source identity from the original ledger", () => {
  assert.equal(normalizeEvents([event], names)[0].actor, "Zéphira");
  const separated: NameDictionary = [...names.map((e) => ({ ...e, aliases: e.aliases.map((a) => ({ ...a, status: "rejected" as const })) })),
    { id: "separate", canonical: "Séphira", kind: "PNJ", status: "confirmed", aliases: [] }];
  const restored = normalizeEvents([event], validateDictionary(separated));
  assert.equal(restored[0].actor, "Séphira");
  assert.equal(restored[0].actorId, "separate");
});

test("human aliases supersede an AI canonical spelling and AI assignments stay inactive", () => {
  const cast = buildCastSheet([{ playerName: "", characterName: "Zéphira", aliases: "Séphira", role: "npc" }]);
  const dictionary = seedDictionary(cast, [event], [{ ...names[0], canonical: "Séphira", aliases: [], assignedEventIds: ["e1"] }]);
  assert.equal(dictionary.length, 1);
  assert.equal(dictionary[0].canonical, "Zéphira");
  assert.equal(normalizeEvents([event], dictionary)[0].actor, "Zéphira");
  assert.ok(!dictionary[0].assignedEventIds?.length);
});
