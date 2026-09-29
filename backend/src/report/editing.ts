/**
 * Édition d'un compte-rendu déjà généré : correction ciblée d'un passage, mise à jour d'une scène
 * éditée à la main, régénération d'une scène. Toujours la même politique : l'utilisateur fait foi.
 */
import { z } from "zod/v4";
import { generateJson, generateText } from "../config/genai.js";
import { ATTRIBUTION_RULES } from "../config/report-style.js";
import { buildCastSheet, castText } from "../pipeline/cast.js";
import { rewriteChapter } from "../pipeline/ledger-pipeline.js";
import type { LedgerEvent } from "../pipeline/ledger-schemas.js";
import { extractSceneText } from "../tools/transcript-input.js";
import { formatReport } from "./formatter.js";
import type { PlayerDraft, ReportState, SceneMeta, SceneSummary } from "./types.js";

export interface StoredReport {
  reportMd: string;
  players: PlayerDraft[];
  workflowState: Record<string, unknown> | null;
  preprocessedTranscript: string | null;
  sessionHistory: string | null;
}

export function reportState(report: StoredReport): ReportState & Record<string, unknown> {
  const ws = report.workflowState ?? {};
  return {
    ...ws,
    universeName: (ws.universeName as string) ?? "",
    sessionTitle: ws.sessionTitle as string | undefined,
    playerInfo: ((ws.playerInfo as PlayerDraft[]) ?? report.players ?? [])
      .filter((p) => (p.role ?? "player") === "player" && p.characterName)
      .map((p) => ({ playerName: p.playerName, characterName: p.characterName })),
    scenes: (ws.scenes as SceneMeta[]) ?? [],
    sceneSummaries: (ws.sceneSummaries as SceneSummary[]) ?? [],
    entities: (ws.entities as ReportState["entities"]) ?? { pcs: [], npcs: [], locations: [], items: [] },
  };
}

export function renderReport(state: ReportState): string {
  return formatReport(state);
}

function sceneTranscript(report: StoredReport, scene?: SceneMeta): string {
  if (!report.preprocessedTranscript || !scene) return "";
  return extractSceneText(report.preprocessedTranscript, scene.startLine, scene.endLine);
}

// ── Correction ciblée d'un passage ───────────────────────────────────────────

/** Section « ## … » (ou bloc entre deux « --- ») qui contient le passage sélectionné. */
export function extractSectionContaining(report: string, selectedText: string) {
  const selectionIndex = report.indexOf(selectedText);
  if (selectionIndex === -1) {
    return { text: report, start: 0, end: report.length, selectionFound: false };
  }
  const headingPattern = /^---$|^## /;
  const lines = report.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  let startLine = 0;
  let endLine = lines.length;
  for (let i = 0; i < lines.length && offsets[i] <= selectionIndex; i++) {
    if (headingPattern.test(lines[i])) startLine = i;
  }
  for (let i = startLine + 1; i < lines.length; i++) {
    if (!headingPattern.test(lines[i])) continue;
    if (offsets[i] > selectionIndex + selectedText.length) {
      endLine = i;
      break;
    }
    startLine = i;
  }
  const start = offsets[startLine];
  const end = endLine < lines.length ? offsets[endLine] : report.length;
  return { text: report.slice(start, end), start, end, selectionFound: true };
}

export async function correctPassage(
  report: StoredReport,
  selectedText: string,
  instruction: string
): Promise<{ reportMd: string; sectionChanged: boolean; matchedScene: string | null }> {
  const section = extractSectionContaining(report.reportMd, selectedText);
  const state = reportState(report);
  const heading = section.text.match(/^## (.+)$/m)?.[1]?.replace(/^Chapitre \d+\s*:\s*/, "").trim();
  const scene = heading ? state.scenes.find((s) => s.title === heading) : undefined;
  const transcript = sceneTranscript(report, scene);
  const cast = buildCastSheet(report.players ?? []);

  const corrected = await generateText({
    task: "edit",
    temperature: 0.15,
    system:
      "Tu édites un compte-rendu de jeu de rôle au format Markdown. On te donne UNE section et une demande de correction " +
      "ciblée : retourne UNIQUEMENT la section corrigée, prête à remplacer l'originale.\n" +
      "- Ne modifie que ce qui est demandé ; conserve style, structure et formatage Markdown.\n" +
      "- La demande de l'utilisateur fait foi : il était à la table. Les étiquettes de locuteur du transcript viennent " +
      "d'une diarisation imparfaite et ne sont qu'un indice.\n" +
      "- Ne supprime rien et n'ajoute rien qui ne soit demandé.\n\n" +
      ATTRIBUTION_RULES,
    parts: [
      `CASTING :\n${castText(cast)}`,
      `SECTION À MODIFIER :\n${section.text}`,
      transcript ? `TRANSCRIPT DE LA SCÈNE « ${scene!.title} » :\n${transcript}` : "",
      `PASSAGE SÉLECTIONNÉ : « ${selectedText} »`,
      `CORRECTION DEMANDÉE : ${instruction}`,
      "Retourne UNIQUEMENT la section corrigée.",
    ].filter(Boolean),
  });

  const reportMd = report.reportMd.slice(0, section.start) + corrected.trimEnd() + "\n" + report.reportMd.slice(section.end);
  return { reportMd, sectionChanged: corrected.trim() !== section.text.trim(), matchedScene: scene?.title ?? null };
}

// ── Scène éditée à la main ───────────────────────────────────────────────────

const SceneMetadataSchema = z.object({
  diceRolls: z
    .array(
      z.object({
        character: z.string().describe("personnage qui lance le dé"),
        skill: z.string().describe("trait, compétence ou sphères"),
        result: z.string().describe("résultat (succès, échec, détails)"),
        context: z.string().describe("but de l'action"),
      })
    )
    .describe("jets de dés explicitement mentionnés dans le récit"),
  npcsInvolved: z.array(z.string()).describe("PNJ du récit, format « Nom : rôle »"),
  technicalNotes: z.array(z.string()).describe("notes techniques, format « Mécanique : explication »"),
  keyEvents: z.array(z.string()).describe("événements clés dans l'ordre, format « Personnage : action »"),
});

/** Met à jour la narration d'une scène et ré-extrait ses encadrés depuis le texte édité. */
export async function updateSceneNarrative(report: StoredReport, sceneId: number, narrativeSummary: string) {
  const state = reportState(report);
  const index = state.sceneSummaries.findIndex((s) => s.sceneId === sceneId);
  if (index === -1) return null;
  const scene = state.scenes.find((s) => s.id === sceneId);
  const transcript = sceneTranscript(report, scene);

  let metadata: z.infer<typeof SceneMetadataSchema> | null = null;
  try {
    metadata = await generateJson({
      task: "edit",
      temperature: 0.1,
      schema: SceneMetadataSchema,
      system:
        "Tu extrais les encadrés d'une scène de compte-rendu de jeu de rôle à partir de son récit, qui fait foi " +
        "(il vient d'être corrigé par l'utilisateur). N'invente rien qui ne soit dans le récit.",
      parts: [
        `CASTING :\n${castText(buildCastSheet(report.players ?? []))}`,
        `RÉCIT DE LA SCÈNE :\n${narrativeSummary}`,
        transcript ? `TRANSCRIPT (référence pour les valeurs de dés) :\n${transcript}` : "",
      ].filter(Boolean),
    });
  } catch {
    metadata = null; // on garde les encadrés existants
  }

  const updated: SceneSummary = { ...state.sceneSummaries[index], narrativeSummary, ...(metadata ?? {}) };
  const sceneSummaries = state.sceneSummaries.map((s, i) => (i === index ? updated : s));
  const next = { ...state, sceneSummaries };
  return { workflowState: next, reportMd: renderReport(next), updatedSummary: updated };
}

// ── Régénération d'une scène ─────────────────────────────────────────────────

export async function regenerateScene(report: StoredReport, sceneId: number, instruction?: string) {
  const state = reportState(report);
  const scene = state.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;

  const ledgerEvents = ((state.ledger as { events?: LedgerEvent[] } | undefined)?.events ?? []).filter((e) =>
    scene.eventIds?.includes(e.id)
  );
  const { text, metadata } = await rewriteChapter({
    cast: buildCastSheet(report.players ?? []),
    sessionHistory: report.sessionHistory ?? "",
    title: scene.title,
    location: scene.location,
    allTitles: state.scenes.map((s) => s.title),
    events: ledgerEvents,
    transcriptExcerpt: sceneTranscript(report, scene),
    instruction,
  });

  const existing = state.sceneSummaries.find((s) => s.sceneId === sceneId);
  const regenerated: SceneSummary = {
    sceneId,
    narrativeSummary: text,
    keyEvents: metadata?.keyEvents ?? existing?.keyEvents ?? [],
    diceRolls: metadata?.diceRolls ?? existing?.diceRolls ?? [],
    npcsInvolved: existing?.npcsInvolved ?? [],
    technicalNotes: existing?.technicalNotes ?? [],
  };
  const sceneSummaries = existing
    ? state.sceneSummaries.map((s) => (s.sceneId === sceneId ? regenerated : s))
    : [...state.sceneSummaries, regenerated].sort((a, b) => a.sceneId - b.sceneId);
  const next = { ...state, sceneSummaries };
  return { workflowState: next, reportMd: renderReport(next), regeneratedSummary: regenerated };
}
