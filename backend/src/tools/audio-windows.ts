/**
 * Découpe un audio en fenêtres qui se chevauchent (ffmpeg), en mono 16 kHz :
 * Gemini sous-échantillonne de toute façon, et des fichiers légers s'uploadent vite.
 */
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";

export interface AudioWindow {
  index: number;
  start: number; // secondes, dans l'audio d'origine
  end: number;
  path: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd} a échoué (${code}): ${err.slice(-500)}`))));
  });
}

export async function audioDuration(path: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ]);
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`Durée audio illisible pour ${path}`);
  return d;
}

export function planWindows(duration: number, windowSec: number, overlapSec: number): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  const step = windowSec - overlapSec;
  for (let start = 0; start < duration; start += step) {
    const end = Math.min(duration, start + windowSec);
    windows.push({ start, end });
    if (end >= duration) break;
  }
  // Évite une dernière fenêtre minuscule : on la fusionne avec la précédente.
  if (windows.length > 1) {
    const last = windows[windows.length - 1];
    if (last.end - last.start < overlapSec * 2) {
      windows.pop();
      windows[windows.length - 1].end = duration;
    }
  }
  return windows;
}

export async function splitAudio(
  path: string,
  outDir: string,
  windowSec = 25 * 60,
  overlapSec = 2 * 60
): Promise<AudioWindow[]> {
  await mkdir(outDir, { recursive: true });
  const duration = await audioDuration(path);
  const plan = planWindows(duration, windowSec, overlapSec);
  const windows: AudioWindow[] = [];
  for (const [index, w] of plan.entries()) {
    const out = resolve(outDir, `window-${String(index).padStart(2, "0")}.mp3`);
    if (!existsSync(out)) {
      await run("ffmpeg", [
        "-v", "error", "-y",
        "-ss", String(w.start), "-t", String(w.end - w.start),
        "-i", path,
        "-ac", "1", "-ar", "16000", "-b:a", "48k",
        out,
      ]);
    }
    windows.push({ index, start: w.start, end: w.end, path: out });
  }
  return windows;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Convertit un audio entier en MP3 mono 16 kHz (format sûr et léger pour Gemini). */
export async function transcodeForGemini(path: string, out: string): Promise<string> {
  if (!existsSync(out)) {
    await run("ffmpeg", ["-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", "-b:a", "48k", out]);
  }
  return out;
}

/** Extrait [start, end] d'un audio vers un fichier MP3 mono 16 kHz. */
export async function cutAudio(path: string, start: number, end: number, out: string): Promise<string> {
  const duration = Math.max(0.5, end - start);
  await run("ffmpeg", [
    "-v", "error", "-y", "-ss", String(Math.max(0, start)), "-t", String(duration),
    "-i", path, "-ac", "1", "-ar", "16000", "-b:a", "48k", out,
  ]);
  return out;
}

/** Diffuse [start, end] d'un audio en MP3 sur la sortie standard de ffmpeg (écoute dans le navigateur). */
export function streamAudioSegment(path: string, start: number, end: number) {
  const duration = Math.max(0.5, end - start);
  return spawn("ffmpeg", [
    "-v", "error", "-ss", String(Math.max(0, start)), "-t", String(duration),
    "-i", path, "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1",
  ]);
}
