/**
 * Utilitaires HTTP : upload sur disque (enregistrements volumineux), SSE.
 */
import type { Response } from "express";
import multer from "multer";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { dataDir } from "../config/database.js";

export const uploadsDir = resolve(dataDir, "uploads");
mkdirSync(uploadsDir, { recursive: true });

/** Un enregistrement de séance pèse facilement plusieurs centaines de Mo : écriture sur disque. */
export const upload = multer({ dest: uploadsDir, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

/** busboy décode les noms de fichiers en latin1 : « sÃ©ance » redevient « séance ». */
export function uploadName(file: Express.Multer.File): string {
  const decoded = Buffer.from(file.originalname, "latin1").toString("utf8");
  return decoded.includes("�") ? file.originalname : decoded;
}

export const AUDIO_EXTENSIONS = /\.(aac|m4a|mp3|wav|ogg|oga|opus|flac|webm|mp4)$/i;

export function isAudioUpload(file?: Express.Multer.File): boolean {
  if (!file) return false;
  return file.mimetype.startsWith("audio/") || AUDIO_EXTENSIONS.test(uploadName(file));
}

export function initSSE(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function writeSSEEvent(res: Response, type: string, data: unknown, id?: number): void {
  if (typeof id === "number") res.write(`id: ${id}\n`);
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function bodyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
