/**
 * Upload par morceaux des enregistrements : chaque requête reste courte (≤ 16 Mo), ce qui évite les
 * coupures des proxys (Traefik v3 limite la lecture d'une requête à 60 s par défaut) et permet de
 * renvoyer un morceau qui a échoué sans tout recommencer.
 *
 *   POST /api/uploads                    { fileName, size } → { uploadId, chunkSize }
 *   PUT  /api/uploads/:id/chunks/:index  corps binaire (application/octet-stream)
 *   puis POST /api/jobs avec uploadId au lieu du fichier.
 */
import express, { Router } from "express";
import { appendFileSync, existsSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { bodyString, uploadsDir } from "../lib/http.js";

export const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const STALE_MS = 6 * 60 * 60 * 1000;

interface PendingUpload {
  id: string;
  fileName: string;
  size: number;
  path: string;
  nextIndex: number;
  received: number;
  updatedAt: number;
}

const uploads = new Map<string, PendingUpload>();

function cleanupStale(): void {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.updatedAt > STALE_MS) {
      uploads.delete(id);
      rmSync(u.path, { force: true });
    }
  }
}

/** Récupère un upload terminé pour créer un job ; le fichier appartient ensuite à l'appelant. */
export function takeCompletedUpload(id: string): { path: string; fileName: string } | { error: string } {
  const u = uploads.get(id);
  if (!u) return { error: "Envoi introuvable ou expiré : renvoie le fichier." };
  if (u.received !== u.size || !existsSync(u.path) || statSync(u.path).size !== u.size) {
    return { error: `Envoi incomplet (${u.received} / ${u.size} octets).` };
  }
  uploads.delete(id);
  return { path: u.path, fileName: u.fileName };
}

export const uploadsRouter = Router();

uploadsRouter.post("/", (req, res) => {
  cleanupStale();
  const fileName = bodyString(req.body?.fileName);
  const size = Number(req.body?.size);
  if (!fileName || !Number.isFinite(size) || size <= 0) {
    return void res.status(400).json({ message: "Nom et taille du fichier requis." });
  }
  if (size > MAX_UPLOAD_BYTES) return void res.status(413).json({ message: "Fichier trop volumineux (2 Go max)." });
  const id = randomUUID();
  uploads.set(id, { id, fileName, size, path: resolve(uploadsDir, `chunked-${id}`), nextIndex: 0, received: 0, updatedAt: Date.now() });
  res.status(201).json({ uploadId: id, chunkSize: CHUNK_SIZE });
});

uploadsRouter.put(
  "/:id/chunks/:index",
  express.raw({ type: "application/octet-stream", limit: CHUNK_SIZE * 2 }),
  (req, res) => {
    const u = uploads.get(req.params.id);
    const index = Number.parseInt(req.params.index, 10);
    if (!u) return void res.status(404).json({ message: "Envoi introuvable ou expiré." });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return void res.status(400).json({ message: "Morceau vide." });
    }
    // Un morceau déjà reçu (renvoi après une réponse perdue) est accepté sans être réécrit.
    if (index < u.nextIndex) return void res.json({ received: u.received, nextIndex: u.nextIndex });
    if (index > u.nextIndex) {
      return void res.status(409).json({ message: `Morceau ${u.nextIndex} attendu.`, nextIndex: u.nextIndex });
    }
    if (u.received + req.body.length > u.size) return void res.status(400).json({ message: "Morceau en trop." });
    appendFileSync(u.path, req.body);
    u.received += req.body.length;
    u.nextIndex++;
    u.updatedAt = Date.now();
    res.json({ received: u.received, nextIndex: u.nextIndex });
  }
);
