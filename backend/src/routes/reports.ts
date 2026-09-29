/**
 * Comptes-rendus enregistrés (SQLite) et leur édition.
 */
import { Router } from "express";
import { randomUUID } from "crypto";
import {
  deleteReport,
  getReport,
  insertCorrection,
  listCorrections,
  listReports,
  updateReportMd,
  updateReportWorkflowState,
} from "../config/database.js";
import { bodyString } from "../lib/http.js";
import { errorMessage, log } from "../lib/log.js";
import {
  correctPassage,
  regenerateScene,
  renderReport,
  reportState,
  updateSceneNarrative,
  type StoredReport,
} from "../report/editing.js";
import type { PlayerDraft } from "../report/types.js";
import { extractSceneText } from "../tools/transcript-input.js";

export const reportsRouter = Router();

function loadReport(id: string): (StoredReport & ReturnType<typeof getReport>) | null {
  const report = getReport(id);
  return report ? { ...report, players: report.players as PlayerDraft[] } : null;
}

const sceneIdOf = (value: string) => {
  const id = Number.parseInt(value, 10);
  return Number.isFinite(id) ? id : null;
};

reportsRouter.get("/", (_req, res) => {
  try {
    res.json(listReports());
  } catch {
    res.status(500).json({ message: "Erreur lors de la lecture des rapports." });
  }
});

reportsRouter.get("/:id", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  // Pas les champs lourds dans le détail.
  const { workflowState, rawTranscript, preprocessedTranscript, universeContext, sessionHistory, ...rest } = report;
  const cost = workflowState?.cost as { costUsd?: number; calls?: number } | undefined;
  res.json({ ...rest, cost: cost ? { costUsd: cost.costUsd ?? 0, calls: cost.calls ?? 0 } : null });
});

reportsRouter.get("/:id/full", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  res.json(report);
});

reportsRouter.delete("/:id", (req, res) => {
  if (!deleteReport(req.params.id)) return void res.status(404).json({ message: "Rapport introuvable." });
  res.json({ message: "Rapport supprimé." });
});

reportsRouter.get("/:id/corrections", (req, res) => {
  if (!getReport(req.params.id)) return void res.status(404).json({ message: "Rapport introuvable." });
  res.json(listCorrections(req.params.id));
});

/** Correction ciblée : l'utilisateur sélectionne un passage et décrit la correction. */
reportsRouter.post("/:id/correct", async (req, res) => {
  const reportId = req.params.id;
  const report = loadReport(reportId);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  const selectedText = bodyString(req.body?.selectedText);
  const instruction = bodyString(req.body?.instruction);
  if (!selectedText) return void res.status(400).json({ message: "Texte sélectionné requis." });
  if (!instruction) return void res.status(400).json({ message: "Instruction de correction requise." });

  try {
    const { reportMd, sectionChanged, matchedScene } = await correctPassage(report, selectedText, instruction);
    const correctionId = randomUUID();
    insertCorrection({ id: correctionId, reportId, selectedText, instruction, previousReportMd: report.reportMd });
    updateReportMd(reportId, reportMd);
    log("Correction appliquée", { reportId, correctionId, sectionChanged, matchedScene });
    res.json({ reportId, correctionId, reportMd });
  } catch (err) {
    log("Correction en erreur", { reportId, error: errorMessage(err) });
    res.status(500).json({ message: errorMessage(err, "Erreur lors de la correction.") });
  }
});

// ── Scènes ───────────────────────────────────────────────────────────────────

reportsRouter.get("/:id/scenes", (req, res) => {
  const report = loadReport(req.params.id);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  const state = reportState(report);
  const summaries = new Map(state.sceneSummaries.map((s) => [s.sceneId, s]));
  res.json({
    scenes: state.scenes.map((scene) => {
      const isMeta = scene.type === "meta" || scene.type === "pause";
      return {
        ...scene,
        synopsis: scene.summary ?? null,
        transcriptExcerpt:
          isMeta && report.preprocessedTranscript
            ? extractSceneText(report.preprocessedTranscript, scene.startLine, scene.endLine)
            : null,
        summary: summaries.get(scene.id) ?? null,
      };
    }),
  });
});

/** Narration d'une scène éditée à la main : ses encadrés sont ré-extraits du texte. */
reportsRouter.put("/:id/scenes/:sceneId", async (req, res) => {
  const reportId = req.params.id;
  const sceneId = sceneIdOf(req.params.sceneId);
  if (sceneId === null) return void res.status(400).json({ message: "ID de scène invalide." });
  const report = loadReport(reportId);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  const narrativeSummary = bodyString(req.body?.narrativeSummary);
  if (!narrativeSummary) return void res.status(400).json({ message: "Le contenu narratif est requis." });

  try {
    const updated = await updateSceneNarrative(report, sceneId, narrativeSummary);
    if (!updated) return void res.status(404).json({ message: "Scène introuvable." });
    updateReportWorkflowState(reportId, updated.workflowState);
    updateReportMd(reportId, updated.reportMd);
    log("Scène mise à jour", { reportId, sceneId });
    res.json({ reportId, sceneId, reportMd: updated.reportMd, updatedSummary: updated.updatedSummary });
  } catch (err) {
    log("Mise à jour de scène en erreur", { reportId, sceneId, error: errorMessage(err) });
    res.status(500).json({ message: errorMessage(err, "Erreur lors de la mise à jour de la scène.") });
  }
});

/** Reconstruit le markdown depuis les scènes enregistrées (sans appel LLM). */
reportsRouter.post("/:id/rebuild", (req, res) => {
  const report = loadReport(req.params.id);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });
  try {
    const reportMd = renderReport(reportState(report));
    updateReportMd(req.params.id, reportMd);
    res.json({ reportId: req.params.id, reportMd });
  } catch (err) {
    res.status(500).json({ message: errorMessage(err, "Erreur lors de la reconstruction du rapport.") });
  }
});

/** Réécrit une scène depuis son registre (ou son transcript), avec une consigne facultative. */
reportsRouter.post("/:id/scenes/:sceneId/regenerate", async (req, res) => {
  const reportId = req.params.id;
  const sceneId = sceneIdOf(req.params.sceneId);
  if (sceneId === null) return void res.status(400).json({ message: "ID de scène invalide." });
  const report = loadReport(reportId);
  if (!report) return void res.status(404).json({ message: "Rapport introuvable." });

  try {
    const instruction = bodyString(req.body?.instruction) || undefined;
    const regenerated = await regenerateScene(report, sceneId, instruction);
    if (!regenerated) return void res.status(404).json({ message: "Scène introuvable." });
    updateReportWorkflowState(reportId, regenerated.workflowState);
    updateReportMd(reportId, regenerated.reportMd);
    log("Scène régénérée", { reportId, sceneId, hasInstruction: !!instruction });
    res.json({
      reportId,
      sceneId,
      reportMd: regenerated.reportMd,
      regeneratedSummary: regenerated.regeneratedSummary,
    });
  } catch (err) {
    log("Régénération de scène en erreur", { reportId, sceneId, error: errorMessage(err) });
    res.status(500).json({ message: errorMessage(err, "Erreur lors de la régénération de la scène.") });
  }
});
