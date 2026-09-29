/**
 * Échantillons de voix par univers : ajout, écoute, validation d'un échantillon proposé, suppression.
 */
import { Router } from "express";
import { existsSync, rmSync } from "fs";
import { deleteVoiceprint, getVoiceprint, listVoiceprints, updateVoiceprint, type VoiceprintRow } from "../config/database.js";
import { bodyString, isAudioUpload, upload, uploadName } from "../lib/http.js";
import { errorMessage } from "../lib/log.js";
import { MAX_VOICEPRINT_SEC, saveVoiceprintClip } from "../pipeline/voiceprint-store.js";
import { audioDuration } from "../tools/audio-windows.js";
import { safeUniverseId } from "./universes.js";

export function voiceprintView(v: VoiceprintRow) {
  return {
    id: v.id,
    universeId: v.universeId,
    personName: v.personName,
    durationSec: v.durationSec,
    source: v.source,
    status: v.status,
    createdAt: v.createdAt,
  };
}

/** Monté sur /api/universes : GET|POST /:id/voiceprints. */
export const universeVoiceprintsRouter = Router();

universeVoiceprintsRouter.get("/:id/voiceprints", (req, res) => {
  const universeId = safeUniverseId(req.params.id ?? "");
  if (!universeId) return void res.status(400).json({ message: "Identifiant univers invalide." });
  res.json(listVoiceprints(universeId).map(voiceprintView));
});

universeVoiceprintsRouter.post("/:id/voiceprints", upload.single("clip"), async (req, res) => {
  const universeId = safeUniverseId(String(req.params.id ?? ""));
  const personName = bodyString(req.body?.personName);
  try {
    if (!universeId || !personName || !req.file || !isAudioUpload(req.file)) {
      return void res.status(400).json({ message: "Univers, personne et fichier audio requis." });
    }
    const duration = Math.min(await audioDuration(req.file.path), MAX_VOICEPRINT_SEC);
    const saved = await saveVoiceprintClip({
      universeId,
      personName,
      audioPath: req.file.path,
      start: 0,
      end: duration,
      source: uploadName(req.file),
    });
    res.status(201).json(voiceprintView(saved));
  } catch (err) {
    res.status(500).json({ message: errorMessage(err, "Échantillon impossible à enregistrer.") });
  } finally {
    if (req.file) rmSync(req.file.path, { force: true });
  }
});

/** Monté sur /api/voiceprints. */
export const voiceprintsRouter = Router();

voiceprintsRouter.get("/:id/audio", (req, res) => {
  const v = getVoiceprint(req.params.id);
  if (!v || !existsSync(v.clipPath)) return void res.status(404).json({ message: "Échantillon introuvable." });
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(v.clipPath);
});

/** Valider un échantillon proposé (status=confirmed) ou l'attribuer à une autre personne. */
voiceprintsRouter.patch("/:id", (req, res) => {
  const status = req.body?.status === "confirmed" || req.body?.status === "pending" ? req.body.status : undefined;
  const personName = bodyString(req.body?.personName) || undefined;
  if (!updateVoiceprint(req.params.id, { status, personName })) {
    return void res.status(404).json({ message: "Échantillon introuvable." });
  }
  res.json(voiceprintView(getVoiceprint(req.params.id)!));
});

voiceprintsRouter.delete("/:id", (req, res) => {
  const v = getVoiceprint(req.params.id);
  if (!v) return void res.status(404).json({ message: "Échantillon introuvable." });
  deleteVoiceprint(v.id);
  rmSync(v.clipPath, { force: true });
  res.status(204).end();
});
