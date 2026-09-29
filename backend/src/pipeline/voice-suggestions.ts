/**
 * Propose des extraits « propres » pour servir d'échantillons de voix : une seule voix,
 * assez longs, attribués avec assurance à une personne et jamais corrigés par l'analyse.
 * L'utilisateur les valide ensuite à l'oreille ; seuls les échantillons validés servent à l'analyse.
 */
import type { WhisperSegment } from "../tools/transcription-client.js";
import type { VoiceMap } from "./ledger-schemas.js";

export interface VoiceClipSuggestion {
  person: string;
  start: number;
  end: number;
  text: string;
}

interface SuggestOptions {
  perPerson?: number;
  minSec?: number;
  maxSec?: number;
  /** Part minimale d'une voix diarisée attribuée à la personne pour qu'on lui fasse confiance. */
  minShare?: number;
}

export function suggestVoiceClips(
  segments: WhisperSegment[],
  voiceMap: VoiceMap,
  corrections: { segId: number }[],
  people: string[],
  opts: SuggestOptions = {}
): VoiceClipSuggestion[] {
  const { perPerson = 2, minSec = 6, maxSec = 25, minShare = 0.8 } = opts;
  const corrected = new Set(corrections.map((c) => c.segId));
  const wanted = new Set(people.map((p) => p.toLowerCase()));
  const reliable = new Map(
    voiceMap.voices
      .filter((v) => v.share >= minShare && wanted.has(v.mainPerson.toLowerCase()))
      .map((v) => [v.speakerId, v.mainPerson])
  );

  // Tours de parole : segments consécutifs d'une même voix fiable, sans coupure de plus d'une seconde.
  const isClean = (seg: WhisperSegment, i: number) =>
    !!seg.speaker &&
    reliable.has(seg.speaker) &&
    !corrected.has(i) &&
    new Set((seg.words ?? []).map((w) => w.speaker).filter(Boolean)).size <= 1;
  const turns: { speaker: string; start: number; end: number; text: string; words: number }[] = [];
  let current: (typeof turns)[number] | null = null;
  segments.forEach((seg, i) => {
    const words = seg.text.trim().split(/\s+/).filter(Boolean).length;
    if (!isClean(seg, i)) {
      current = null;
      return;
    }
    if (current && current.speaker === seg.speaker && seg.start - current.end < 1 && seg.end - current.start <= maxSec) {
      current.end = seg.end;
      current.text += ` ${seg.text.trim()}`;
      current.words += words;
    } else {
      current = { speaker: seg.speaker!, start: seg.start, end: seg.end, text: seg.text.trim(), words };
      turns.push(current);
    }
  });

  const candidates = turns
    .filter((t) => {
      const duration = t.end - t.start;
      // Parole continue : un long tour avec peu de mots est surtout du silence ou du bruit.
      return duration >= minSec && duration <= maxSec && t.words / duration >= 1.8;
    })
    .sort((a, b) => b.end - b.start - (a.end - a.start));

  const byPerson = new Map<string, VoiceClipSuggestion[]>();
  for (const turn of candidates) {
    const person = reliable.get(turn.speaker)!;
    const list = byPerson.get(person) ?? [];
    // Deux extraits éloignés dans la séance : plus représentatifs qu'un seul moment.
    if (list.length >= perPerson || list.some((c) => Math.abs(c.start - turn.start) < 600)) continue;
    list.push({ person, start: turn.start, end: turn.end, text: turn.text });
    byPerson.set(person, list);
  }
  return [...byPerson.values()].flat();
}
