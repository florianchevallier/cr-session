/**
 * Normalise les entrées texte en segments : JSON WhisperX (horodaté) ou transcript
 * historique « [SPEAKER_XX] texte » / « SPEAKER_XX: texte » (sans horodatage).
 */
import type { WhisperResult } from "./transcription-client.js";

export interface SessionTranscript extends WhisperResult {
  /** false quand les segments viennent d'un .txt sans horodatage (start = index). */
  timed: boolean;
}

const BRACKET_RE = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?\[([A-Za-z_]+\d+)\]\s*(.*)$/;
const COLON_RE = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?([A-Z_]+\d+)\s*:\s*(.*)$/;

function clockToSeconds(clock?: string): number | null {
  if (!clock) return null;
  const parts = clock.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function isWhisperJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed?.segments);
  } catch {
    return false;
  }
}

export function parseTranscriptInput(text: string): SessionTranscript {
  if (isWhisperJson(text)) {
    const parsed = JSON.parse(text) as WhisperResult;
    return { ...parsed, segments: parsed.segments.filter((s) => s.text?.trim()), timed: true };
  }

  const segments: WhisperResult["segments"] = [];
  let timed = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(BRACKET_RE) ?? line.match(COLON_RE);
    const clock = clockToSeconds(m?.[1]);
    if (clock !== null) timed = true;
    const index = segments.length;
    if (m) {
      segments.push({ start: clock ?? index, end: clock ?? index, speaker: m[2], text: m[3].trim() });
    } else if (segments.length) {
      // Ligne de continuation non étiquetée : rattachée au tour précédent.
      segments[segments.length - 1].text += ` ${line}`;
    } else {
      segments.push({ start: index, end: index, speaker: "UNTAGGED", text: line });
    }
  }
  return { segments: segments.filter((s) => s.text.trim()), timed };
}

/** Transcript nommé au format historique « L<n> [Personne] texte », compatible avec l'édition de scènes. */
export function namedTranscript(
  segments: WhisperResult["segments"],
  names: Map<number, string>
): string {
  return segments
    .map((s, i) => `L${i + 1} [${names.get(i) ?? s.speaker ?? "UNTAGGED"}] ${s.text.trim()}`)
    .join("\n");
}

/** Lignes [startLine, endLine] d'un transcript nommé « L<n> [Personne] texte ». */
export function extractSceneText(transcript: string, startLine: number, endLine: number): string {
  return transcript
    .split("\n")
    .filter((line) => {
      const match = line.match(/^L(\d+)\s/);
      if (!match) return false;
      const n = Number(match[1]);
      return n >= startLine && n <= endLine;
    })
    .join("\n");
}
