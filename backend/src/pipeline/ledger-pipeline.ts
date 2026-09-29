/**
 * Pipeline « écoute d'abord, rédige ensuite ».
 *
 *   analyzeSession : carte des voix → registre d'événements par fenêtres (audio + transcript)
 *                    → consolidation globale (chapitres, cohérence des acteurs)
 *   (revue humaine des événements incertains, hors de ce module)
 *   writeSession   : rédaction par chapitre depuis le registre seul → vérification → réécriture
 *                    → état compatible avec l'éditeur de scènes + rapport via le formatter
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { WhisperResult, WhisperSegment } from "../tools/transcription-client.js";
import { splitAudio, formatClock } from "../tools/audio-windows.js";
import { namedTranscript } from "../tools/transcript-input.js";
import { uploadAudio, audioPart, generateJson, generateText, type UploadedAudio } from "../config/genai.js";
import { ATTRIBUTION_RULES } from "../config/report-style.js";
import { formatReport } from "../report/formatter.js";
import type { ReportState, SceneMeta, SceneSummary } from "../report/types.js";
import { castText, castPeople, type CastSheet } from "./cast.js";
import {
  VoiceMapSchema,
  WindowLedgerSchema,
  ConsolidationSchema,
  VerificationSchema,
  type VoiceMap,
  type WindowLedger,
  type LedgerEvent,
  type Consolidation,
} from "./ledger-schemas.js";

export type { CastSheet } from "./cast.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VoiceSample {
  person: string;
  path: string;
}

export interface LedgerPipelineInput {
  whisper: WhisperResult;
  /** false pour un .txt sans horodatage : les fenêtres se font alors par nombre de segments. */
  timed?: boolean;
  audioPath?: string;
  voiceSamples?: VoiceSample[];
  cast: CastSheet;
  universeName?: string;
  universeContext: string;
  sessionHistory: string;
  model?: string;
  cacheDir: string;
  windowMinutes?: number;
  overlapMinutes?: number;
  onProgress?: (step: string, detail?: Record<string, unknown>) => void;
}

export interface SessionAnalysis {
  voiceMap: VoiceMap;
  events: LedgerEvent[];
  consolidation: Consolidation;
  speakerCorrections: { segId: number; person: string; reason: string }[];
}

export interface ReviewDecision {
  eventId: string;
  actor?: string;
  drop?: boolean;
}

export interface ReviewItem {
  eventId: string;
  t: number;
  start: number;
  end: number;
  actor: string;
  spokenBy: string;
  action: string;
  status: string;
  confidence: number;
  evidence: string;
  /** Pourquoi cet événement est soumis à vérification. */
  reasons: string[];
  excerpt: string[];
}

export interface SessionOutput {
  report: string;
  workflowState: ReportState & Record<string, unknown>;
  preprocessedTranscript: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function segmentLine(seg: WhisperSegment, id: number, timed: boolean): string {
  const words = seg.words ?? [];
  const speakers = new Set(words.map((w) => w.speaker).filter(Boolean));
  const mixed = speakers.size > 1 ? ` ⚠voix mêlées(${[...speakers].join("/")})` : "";
  const clock = timed ? ` [${formatClock(seg.start)}]` : "";
  return `#${id}${clock} ${seg.speaker ?? "SPEAKER_?"}${mixed}: ${seg.text.trim()}`;
}

async function cached<T>(path: string, compute: () => Promise<T>): Promise<T> {
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf-8"));
  const value = await compute();
  await writeFile(path, JSON.stringify(value, null, 1));
  return value;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

const segmentsOf = (input: LedgerPipelineInput) => input.whisper.segments.filter((s) => s.text.trim());
const progressOf = (input: LedgerPipelineInput) =>
  input.onProgress ?? ((s: string, d?: Record<string, unknown>) => console.log(`[ledger] ${s}`, d ? JSON.stringify(d) : ""));

// ── Étape 1 : carte des voix ─────────────────────────────────────────────────

async function buildVoiceMap(input: LedgerPipelineInput, fullTranscript: string): Promise<VoiceMap> {
  return generateJson({
    task: "ledger",
    model: input.model,
    temperature: 0,
    schema: VoiceMapSchema,
    system:
      "Tu analyses la diarization automatique d'une séance de jeu de rôle enregistrée avec un seul micro. " +
      "Pour chaque étiquette SPEAKER_XX, détermine quelle personne réelle du casting elle représente MAJORITAIREMENT, " +
      "en choisissant UNIQUEMENT parmi : " + castPeople(input.cast).join(", ") + ". " +
      "Le MJ décrit (« tu vois », « vous arrivez », « fais-moi un jet »), joue les PNJ et donne les difficultés ; " +
      "un joueur parle à la 1re personne pour son personnage (« je lance… », « je fais… »). " +
      "La diarization fusionne souvent des voix : estime la part fiable et qui d'autre est mêlé.",
    parts: [`CASTING :\n${castText(input.cast)}`, `TRANSCRIPT DIARISÉ :\n${fullTranscript}`],
  });
}

// ── Étape 2 : registre par fenêtre ───────────────────────────────────────────

function ledgerSystemPrompt(cast: CastSheet, withAudio: boolean): string {
  const source = withAudio
    ? "Tu ÉCOUTES un extrait audio de la séance et tu LIS son transcript automatique horodaté"
    : "Tu LIS un extrait du transcript automatique de la séance";
  return `Tu es le greffier d'une table de jeu de rôle. ${source} (segments numérotés #id, étiquettes de voix
SPEAKER_XX souvent fausses). Ta mission : produire le registre exact de ce qui se passe DANS LA FICTION, avec pour
chaque événement QUI agit.

Personnes réelles autour de la table : ${castPeople(cast).join(", ")}.

MÉTHODE :
- Identifie qui parle par ${withAudio ? "la voix (timbre, genre, débit ; compare aux échantillons de voix s'il y en a) ET " : ""}le contexte ;
  l'étiquette SPEAKER_XX n'est qu'un indice. Quand une étiquette est clairement fausse, ajoute une entrée dans speakerCorrections.
- Un joueur annonce une action pour SON personnage ; le MJ décrit le monde, fait parler les PNJ, et résout.
  Quand un PNJ agit (même raconté par le MJ), l'acteur est ce PNJ, avec son nom canonique sans parenthèses.
  Quand le MJ joue un PJ qui lui a été confié, les actions de ce PJ sont bien celles de ce PJ.
- Les vocatifs et adresses (« Yumi, tu… », « toi tu vois… ») désignent le personnage à qui ARRIVE la chose.
- Un jet : qui lance, quels Traits/Sphères, combien de dés, difficulté, résultat (succès, échec, échec critique).
  Relie le résultat à l'action annoncée juste avant.
- Jets simultanés : quand plusieurs joueurs lancent en même temps pour la même question, crée UN événement par
  lanceur avec SON résultat ; l'information que le MJ donne ensuite revient à celui dont le jet l'a obtenue.
- Identités d'emprunt : un PJ peut agir sous une autre identité dans la fiction (déguisement, simulation, avatar).
  Si le MJ décrit « le messager », « le garde »… et qu'un joueur joue ce rôle, l'acteur est ce PJ (nom canonique).
- Un JOUEUR peut aussi incarner temporairement un PNJ (après la mort de son PJ, ou pour aider le MJ) : reconnaître
  sa voix ne suffit pas. Si la fiction décrit un inconnu, un ennemi ou un figurant, l'acteur est ce PNJ, même quand
  c'est la voix d'un joueur (spokenBy = ce joueur, actorType = PNJ).
- Distingue intention (« je voudrais », « est-ce que je peux ») et fait accompli (confirmé par le MJ ou le jet).
- Ignore le hors-jeu pur (blagues, pizza, règles) sauf s'il change l'action en fiction.
- Chaque événement cite ses segments (#id) : n'invente rien qui ne soit pas dans ${withAudio ? "l'audio ou " : ""}le transcript.
- Sois EXHAUSTIF : chaque action de PJ (même petite), chaque sort, chaque jet, chaque réplique qui fait avancer
  l'histoire, chaque action décisive d'un PNJ. Un geste commun à deux PJ = un événement par PJ.
  Ordre de grandeur : 30 à 60 événements pour 25 minutes de jeu.
- confidence calibrée : 0.9+ seulement si la voix ET le contexte concordent (ou vocatif explicite) ;
  0.6-0.8 si un seul indice ; < 0.6 si tu hésites entre deux personnes. Explique dans evidence.

${ATTRIBUTION_RULES}`;
}

interface Window {
  index: number;
  from: number; // premier segment (inclus)
  to: number; // dernier segment (exclu)
  start: number;
  end: number;
  audioPath?: string;
}

async function planSessionWindows(input: LedgerPipelineInput, segments: WhisperSegment[]): Promise<{ windows: Window[]; overlapSegs: number; overlapSec: number }> {
  const windowSec = (input.windowMinutes ?? 25) * 60;
  const overlapSec = (input.overlapMinutes ?? 2) * 60;
  const timed = input.timed !== false;

  if (!timed) {
    // Sans horodatage : ~400 segments par fenêtre, 40 de recouvrement.
    const size = 400;
    const overlap = 40;
    const windows: Window[] = [];
    for (let from = 0, index = 0; from < segments.length; from += size - overlap, index++) {
      const to = Math.min(segments.length, from + size);
      windows.push({ index, from, to, start: from, end: to });
      if (to >= segments.length) break;
    }
    return { windows, overlapSegs: overlap, overlapSec: 0 };
  }

  const bySeconds = (start: number, end: number) => {
    const ids = segments.map((s, i) => ({ s, i })).filter(({ s }) => s.start >= start && s.start < end);
    return { from: ids[0]?.i ?? 0, to: (ids[ids.length - 1]?.i ?? -1) + 1 };
  };

  if (input.audioPath) {
    const audioWindows = await splitAudio(input.audioPath, resolve(input.cacheDir, "audio"), windowSec, overlapSec);
    return {
      windows: audioWindows.map((w) => ({ index: w.index, start: w.start, end: w.end, audioPath: w.path, ...bySeconds(w.start, w.end) })),
      overlapSegs: 0,
      overlapSec,
    };
  }

  const lastEnd = segments[segments.length - 1]?.end ?? 0;
  const windows: Window[] = [];
  for (let start = 0, index = 0; start < lastEnd; start += windowSec - overlapSec, index++) {
    const end = Math.min(lastEnd + 1, start + windowSec);
    windows.push({ index, start, end, ...bySeconds(start, end) });
    if (end > lastEnd) break;
  }
  return { windows, overlapSegs: 0, overlapSec };
}

async function ledgerForWindow(
  input: LedgerPipelineInput,
  window: Window,
  lines: string[],
  voiceMap: VoiceMap,
  samples: { person: string; audio: UploadedAudio }[],
  previousState: string
): Promise<WindowLedger> {
  const timed = input.timed !== false;
  const span = timed ? `${formatClock(window.start)} → ${formatClock(window.end)}` : `segments #${window.from} → #${window.to - 1}`;
  const parts: Parameters<typeof generateJson>[0]["parts"] = [
    `CASTING :\n${castText(input.cast)}`,
    `CARTE DES VOIX (a priori, imparfaite) :\n${voiceMap.voices
      .map((v) => `- ${v.speakerId} ≈ ${v.mainPerson} (${Math.round(v.share * 100)} %)${v.alsoContains.length ? `, contient aussi : ${v.alsoContains.join(", ")}` : ""}`)
      .join("\n")}`,
    `ÉTAT DE L'HISTOIRE AU DÉBUT DE CET EXTRAIT :\n${previousState}`,
  ];
  if (window.audioPath) {
    for (const sample of samples) {
      parts.push(`ÉCHANTILLON DE VOIX — ${sample.person} :`, audioPart(sample.audio));
    }
    const audio = await uploadAudio(window.audioPath);
    parts.push(`AUDIO DE LA SÉANCE : l'extrait va de ${span}.`, audioPart(audio));
  }
  parts.push(
    `TRANSCRIPT DE L'EXTRAIT (${span}) :\n${lines.join("\n")}`,
    "Produis le registre des événements de cet extrait, dans l'ordre chronologique."
  );
  return generateJson({
    task: "ledger",
    model: input.model,
    temperature: 0.1,
    schema: WindowLedgerSchema,
    system: ledgerSystemPrompt(input.cast, !!window.audioPath),
    parts,
  });
}

// ── Étape 3 : consolidation ──────────────────────────────────────────────────

function eventLine(e: LedgerEvent, timed: boolean): string {
  const roll = e.roll ? ` | jet: ${e.roll.traits} → ${e.roll.result}${e.roll.dice ? ` (${e.roll.dice})` : ""}` : "";
  const clock = timed ? ` [${formatClock(e.t)}]` : "";
  return `${e.id}${clock} ${e.actor} (${e.actorType}, parlé par ${e.spokenBy}, conf ${e.confidence.toFixed(2)}) ` +
    `${e.status} : ${e.action}${roll} @${e.location} présents=${e.present.join("/")}`;
}

function durationHint(input: LedgerPipelineInput): string {
  const segments = segmentsOf(input);
  if (input.timed === false || !segments.length) return `DURÉE : ${segments.length} répliques.`;
  const minutes = Math.round((segments[segments.length - 1].end - segments[0].start) / 60);
  return `DURÉE DE LA SÉANCE : environ ${minutes} minutes.`;
}

async function consolidate(input: LedgerPipelineInput, events: LedgerEvent[]): Promise<Consolidation> {
  return generateJson({
    task: "consolidate",
    model: input.model,
    temperature: 0,
    schema: ConsolidationSchema,
    system:
      "Tu consolides le registre d'événements d'une séance entière, produit par tranches. " +
      "1) Découpe la séance en chapitres selon les grands mouvements (lieu, objectif, combat) : environ un chapitre par " +
      "20 à 40 minutes de jeu (1 seul pour un court extrait, 8 au plus) ; " +
      "chaque événement appartient à exactement un chapitre, dans l'ordre. " +
      "2) Corrige les incohérences d'attribution visibles à l'échelle de la séance (un PJ absent qui agit, une action " +
      "d'un PNJ donnée à un PJ, un même geste attribué à deux personnages, noms confondus) — uniquement avec une raison " +
      "solide tirée du registre ; retire les doublons et le hors-jeu. 3) Liste les PNJ de chaque chapitre avec leur rôle, " +
      "et 2 à 4 notes techniques (règles, mécaniques, univers) par chapitre. 4) Normalise les variantes de noms.",
    parts: [
      `CASTING :\n${castText(input.cast)}`,
      `CONTEXTE (session précédente) :\n${input.sessionHistory.slice(-20000)}`,
      durationHint(input),
      `REGISTRE :\n${events.map((e) => eventLine(e, input.timed !== false)).join("\n")}`,
    ],
  });
}

function applyFixes(events: LedgerEvent[], c: Consolidation): LedgerEvent[] {
  const canon = new Map(c.canonicalNames.map((n) => [n.variant.toLowerCase(), n.canonical]));
  const fixes = new Map(c.fixes.map((f) => [f.eventId, f]));
  return events
    .filter((e) => !fixes.get(e.id)?.drop)
    .map((e) => {
      const f = fixes.get(e.id);
      const actor = f?.actor?.trim() || e.actor;
      return {
        ...e,
        actor: canon.get(actor.toLowerCase()) ?? actor,
        status: (f?.status?.trim() as LedgerEvent["status"]) || e.status,
      };
    });
}

export async function analyzeSession(input: LedgerPipelineInput): Promise<SessionAnalysis> {
  const progress = progressOf(input);
  const timed = input.timed !== false;
  await mkdir(input.cacheDir, { recursive: true });
  const segments = segmentsOf(input);
  const fullTranscript = segments.map((s, i) => segmentLine(s, i, timed)).join("\n");

  progress("voices");
  const voiceMap = await cached(resolve(input.cacheDir, "voices.json"), () => buildVoiceMap(input, fullTranscript));
  progress("voices:done", { voices: voiceMap.voices.map((v) => `${v.speakerId}=${v.mainPerson}`) });

  const { windows, overlapSegs, overlapSec } = await planSessionWindows(input, segments);
  const samples = input.audioPath
    ? await Promise.all((input.voiceSamples ?? []).map(async (s) => ({ person: s.person, audio: await uploadAudio(s.path) })))
    : [];

  // Registre fenêtre par fenêtre (séquentiel : l'état de fin nourrit la fenêtre suivante).
  let state = "Début de la séance. Reprise après la session précédente (voir casting et contexte).";
  const events: LedgerEvent[] = [];
  const speakerCorrections: SessionAnalysis["speakerCorrections"] = [];
  for (const w of windows) {
    const lines: string[] = [];
    for (let i = w.from; i < w.to; i++) lines.push(segmentLine(segments[i], i, timed));
    progress("window", { index: w.index, of: windows.length, segments: lines.length });
    const ledger = await cached(resolve(input.cacheDir, `window-${w.index}.json`), () =>
      ledgerForWindow(input, w, lines, voiceMap, samples, state)
    );
    state = ledger.stateSummary;

    // Chaque fenêtre « possède » le milieu de ses recouvrements : pas de doublon entre fenêtres.
    const isFirst = w.index === 0;
    const isLast = w.index === windows.length - 1;
    const owns = (segId: number) => {
      if (timed) {
        const t = segments[segId]?.start ?? w.start;
        return (isFirst || t >= w.start + overlapSec / 2) && (isLast || t < w.end - overlapSec / 2);
      }
      return (isFirst || segId >= w.from + overlapSegs / 2) && (isLast || segId < w.to - overlapSegs / 2);
    };
    ledger.events.forEach((e, k) => {
      const valid = e.segIds.filter((id) => id >= 0 && id < segments.length);
      const first = valid.length ? Math.min(...valid) : w.from;
      if (owns(first)) {
        events.push({ ...e, segIds: valid, id: `e${w.index}-${k}`, t: segments[first]?.start ?? first, window: w.index });
      }
    });
    for (const c of ledger.speakerCorrections) {
      if (c.segId >= 0 && c.segId < segments.length && owns(c.segId)) speakerCorrections.push(c);
    }
  }
  events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  progress("ledger:done", { events: events.length, speakerCorrections: speakerCorrections.length });

  progress("consolidate");
  const consolidation = await cached(resolve(input.cacheDir, "consolidation.json"), () => consolidate(input, events));
  progress("consolidate:done", { chapters: consolidation.chapters.length, fixes: consolidation.fixes.length });

  return { voiceMap, events: applyFixes(events, consolidation), consolidation, speakerCorrections };
}

// ── Revue humaine ────────────────────────────────────────────────────────────

/**
 * Événements à faire confirmer. La confiance déclarée par le modèle est peu fiable (souvent constante),
 * on s'appuie donc sur des signaux objectifs de doute sur les segments cités :
 *  - la diarisation et l'analyse ne désignent pas la même personne (correction de locuteur) ;
 *  - les mots d'un segment sont attribués à plusieurs voix (chevauchement, signal d'appoint seulement) ;
 *  - la personne qui parle ne correspond pas au personnage qui agit (ni son joueur, ni le MJ) ;
 *  - confiance déclarée basse.
 */
export function reviewItems(input: LedgerPipelineInput, analysis: SessionAnalysis, max = 20): ReviewItem[] {
  const segments = segmentsOf(input);
  const byVoice = new Map(analysis.voiceMap.voices.map((v) => [v.speakerId, v.mainPerson]));
  const corrections = new Map(analysis.speakerCorrections.map((c) => [c.segId, c.person]));
  const playerOf = new Map(input.cast.players.map((p) => [p.characterName.toLowerCase(), p.playerName]));
  const gm = input.cast.gm.playerName;

  const scored = analysis.events
    .filter((e) => e.actorType === "PJ" || e.roll)
    .map((e) => {
      const reasons: string[] = [];
      for (const id of e.segIds) {
        const seg = segments[id];
        if (!seg) continue;
        const diarized = seg.speaker ? byVoice.get(seg.speaker) : undefined;
        const corrected = corrections.get(id);
        if (corrected && diarized && corrected !== diarized) {
          reasons.push(`la diarisation entend ${diarized}, l'analyse entend ${corrected}`);
        }
        if (new Set((seg.words ?? []).map((w) => w.speaker).filter(Boolean)).size > 1) {
          reasons.push("voix qui se chevauchent");
        }
      }
      const expected = playerOf.get(e.actor.toLowerCase());
      if (e.actorType === "PJ" && expected && e.spokenBy && e.spokenBy !== expected && e.spokenBy !== gm) {
        reasons.push(`action de ${e.actor} dite par ${e.spokenBy}`);
      }
      if (e.confidence < 0.7) reasons.push(`confiance ${Math.round(e.confidence * 100)} %`);
      const unique = [...new Set(reasons)];
      // Le chevauchement seul est trop fréquent (WhisperX mêle souvent les voix au niveau du mot) :
      // il ne fait que renforcer un doute réel.
      const strong = unique.some((r) => r !== "voix qui se chevauchent");
      return { e, reasons: unique, strong };
    })
    .filter((x) => x.strong)
    .sort((a, b) => b.reasons.length - a.reasons.length || a.e.confidence - b.e.confidence)
    .slice(0, max)
    .sort((a, b) => a.e.t - b.e.t);

  return scored.map(({ e, reasons }) => {
    const ids = e.segIds.length ? e.segIds : [0];
    const from = Math.max(0, Math.min(...ids) - 2);
    const to = Math.min(segments.length, Math.max(...ids) + 3);
    const excerpt: string[] = [];
    for (let i = from; i < to; i++) {
      const who = corrections.get(i) ?? (segments[i].speaker ? byVoice.get(segments[i].speaker!) : undefined) ?? "?";
      excerpt.push(`${who} : ${segments[i].text.trim()}`);
    }
    const start = segments[from]?.start ?? 0;
    const end = segments[Math.max(from, to - 1)]?.end ?? start;
    return {
      eventId: e.id,
      t: e.t,
      start,
      end: Math.max(end, start + 4),
      actor: e.actor,
      spokenBy: e.spokenBy,
      action: e.action,
      status: e.status,
      confidence: e.confidence,
      evidence: e.evidence,
      reasons,
      excerpt,
    };
  });
}

export function applyReview(analysis: SessionAnalysis, decisions: ReviewDecision[]): SessionAnalysis {
  const byId = new Map(decisions.map((d) => [d.eventId, d]));
  return {
    ...analysis,
    events: analysis.events
      .filter((e) => !byId.get(e.id)?.drop)
      .map((e) => {
        const d = byId.get(e.id);
        if (!d?.actor?.trim()) return e;
        return { ...e, actor: d.actor.trim(), confidence: 1, evidence: `${e.evidence} [confirmé par l'utilisateur]` };
      }),
  };
}

// ── Étapes 4-5 : rédaction + vérification ────────────────────────────────────

function chapterEventsText(events: LedgerEvent[]): string {
  return events
    .map((e) => {
      const roll = e.roll ? ` [jet ${e.roll.traits} : ${e.roll.result}]` : "";
      const quote = e.quote ? ` Réplique : « ${e.quote} »` : "";
      return `- (${e.id}) ${e.actor} [${e.status}] : ${e.action}${roll}${quote}`;
    })
    .join("\n");
}

async function writeChapter(
  input: LedgerPipelineInput,
  chapter: Consolidation["chapters"][number],
  index: number,
  events: LedgerEvent[],
  allTitles: string[],
  issues?: string
): Promise<string> {
  return generateText({
    task: "writer",
    model: input.model,
    temperature: 0.5,
    system:
      "Tu es le chroniqueur d'une campagne de jeu de rôle. Tu rédiges UN chapitre du compte-rendu, en français, à partir " +
      "d'un registre d'événements vérifié. Le registre fait foi : n'ajoute aucune action, ne change JAMAIS qui fait quoi, " +
      "garde les intentions abandonnées comme telles (ou omets-les), respecte réussites et échecs. " +
      "Tu peux enrichir le style (ambiance, sensations, enchaînements), jamais les faits. " +
      "Imite le style du CR de la session précédente fourni en exemple : narration dense au présent, sphères citées, " +
      "nombre de succès entre parenthèses quand il est connu, répliques en italique. " +
      "Ne mentionne jamais le MJ ni les joueurs réels. Écris UNIQUEMENT la narration du chapitre (paragraphes), " +
      "sans titre ni encadrés : ils sont ajoutés automatiquement.\n\n" + ATTRIBUTION_RULES,
    parts: [
      `CASTING :\n${castText(input.cast)}`,
      input.sessionHistory.trim() ? `EXEMPLE DE STYLE (session précédente) :\n${input.sessionHistory.slice(-15000)}` : "",
      `PLAN DE LA SÉANCE : ${allTitles.map((t, i) => `${i + 1}. ${t}`).join(" | ")}`,
      `CHAPITRE ${index + 1} : ${chapter.title} — lieu : ${chapter.location}`,
      `REGISTRE DU CHAPITRE :\n${chapterEventsText(events)}`,
      issues ? `CORRECTIONS OBLIGATOIRES (une vérification a trouvé ces erreurs dans ta version précédente) :\n${issues}` : "",
    ].filter(Boolean),
  });
}

async function verifyChapter(input: LedgerPipelineInput, text: string, events: LedgerEvent[]) {
  return generateJson({
    task: "verifier",
    model: input.model,
    temperature: 0,
    schema: VerificationSchema,
    system:
      "Tu vérifies un chapitre de compte-rendu contre son registre d'événements (qui fait foi). Signale chaque phrase où : " +
      "l'acteur n'est pas celui du registre (mauvais_acteur), un fait n'est pas dans le registre (non_soutenu — " +
      "l'ambiance et les descriptions ne comptent pas, seulement les actions et résultats), une intention devient un fait " +
      "(intention_comme_fait), un PJ absent agit (personnage_absent), le MJ/les joueurs réels sont mentionnés (mj_mentionne), " +
      "ou un événement du registre avec un acteur PJ ou un jet n'est pas raconté (omis : mets l'id de l'événement dans sentence). " +
      "Ne signale rien d'autre. Liste vide si tout est correct.",
    parts: [`CASTING :\n${castText(input.cast)}`, `REGISTRE :\n${chapterEventsText(events)}`, `CHAPITRE :\n${text}`],
  });
}

/** Jets et événements clés d'un chapitre, tirés du registre (jamais inventés par le rédacteur). */
function eventMetadata(events: LedgerEvent[]): Pick<SceneSummary, "keyEvents" | "diceRolls"> {
  return {
    keyEvents: events
      .filter((e) => e.actorType === "PJ" && e.status !== "intention_abandonnée")
      .map((e) => `${e.actor} : ${e.action}`),
    diceRolls: events
      .filter((e) => e.roll && e.status !== "intention_abandonnée")
      .map((e) => ({ character: e.actor, skill: e.roll!.traits, result: rollResult(e), context: e.action })),
  };
}

function rollResult(e: LedgerEvent): string {
  const r = e.roll!;
  const extra = [r.dice, r.difficulty && `difficulté ${r.difficulty}`].filter(Boolean).join(", ");
  return extra ? `${r.result} (${extra})` : r.result;
}

/** Noms réels des locuteurs par segment : carte des voix, puis corrections segment par segment. */
function speakerNames(input: LedgerPipelineInput, analysis: SessionAnalysis): Map<number, string> {
  const byVoice = new Map(analysis.voiceMap.voices.map((v) => [v.speakerId, v.mainPerson]));
  const names = new Map<number, string>();
  segmentsOf(input).forEach((s, i) => {
    const n = s.speaker ? byVoice.get(s.speaker) : undefined;
    if (n) names.set(i, n);
  });
  for (const c of analysis.speakerCorrections) names.set(c.segId, c.person);
  return names;
}

export async function writeSession(input: LedgerPipelineInput, analysis: SessionAnalysis): Promise<SessionOutput> {
  const progress = progressOf(input);
  const { consolidation } = analysis;
  const byId = new Map(analysis.events.map((e) => [e.id, e]));
  const titles = consolidation.chapters.map((c) => c.title);

  const chapters = await mapLimit(consolidation.chapters, 3, async (chapter, i) => {
    const events = chapter.eventIds.map((id) => byId.get(id)).filter((e): e is LedgerEvent => !!e);
    progress("write", { chapter: i + 1, of: consolidation.chapters.length, title: chapter.title });
    let text = await writeChapter(input, chapter, i, events, titles);
    const check = await verifyChapter(input, text, events);
    if (check.issues.length) {
      progress("rewrite", { chapter: i + 1, issues: check.issues.length });
      const issues = check.issues.map((x) => `- « ${x.sentence} » → ${x.problem} : ${x.fix}`).join("\n");
      text = await writeChapter(input, chapter, i, events, titles, issues);
    }
    progress("write:done", { chapter: i + 1, issues: check.issues.length });
    return { chapter, events, text: text.trim(), issues: check.issues };
  });

  const scenes: SceneMeta[] = chapters.map(({ chapter, events }, i) => {
    const lines = events.flatMap((e) => e.segIds).map((id) => id + 1);
    return {
      id: i + 1,
      title: chapter.title,
      startLine: lines.length ? Math.min(...lines) : 1,
      endLine: lines.length ? Math.max(...lines) : 1,
      type: "narrative",
      location: chapter.location,
      summary: chapter.synopsis,
      eventIds: events.map((e) => e.id),
    };
  });
  const sceneSummaries: SceneSummary[] = chapters.map(({ chapter, events, text }, i) => ({
    sceneId: i + 1,
    narrativeSummary: text,
    ...eventMetadata(events),
    npcsInvolved: chapter.npcs.map((n) => `${n.name} : ${n.role}`),
    technicalNotes: chapter.technicalNotes.map((n) => `${n.label} : ${n.text}`),
  }));
  const npcs = new Map<string, string>();
  for (const c of consolidation.chapters) for (const n of c.npcs) if (!npcs.has(n.name)) npcs.set(n.name, n.role);
  const playerInfo = input.cast.players.map((p) => ({ playerName: p.playerName, characterName: p.characterName }));

  const state: ReportState = {
    universeName: input.universeName ?? "",
    sessionTitle: consolidation.title,
    playerInfo,
    scenes,
    sceneSummaries,
    entities: {
      pcs: input.cast.players.map((p) => ({ name: p.characterName, player: p.playerName })),
      npcs: [...npcs].map(([name, role]) => ({ name, role })),
      locations: [...new Set(consolidation.chapters.map((c) => c.location).filter(Boolean))],
      items: [],
    },
  };

  return {
    report: formatReport(state),
    preprocessedTranscript: namedTranscript(segmentsOf(input), speakerNames(input, analysis)),
    workflowState: {
      ...state,
      speakerMap: Object.fromEntries(analysis.voiceMap.voices.map((v) => [v.speakerId, v.mainPerson])),
      ledger: {
        voiceMap: analysis.voiceMap,
        events: analysis.events,
        speakerCorrections: analysis.speakerCorrections,
        verification: chapters.map((c, i) => ({ sceneId: i + 1, issues: c.issues })),
      },
    },
  };
}

/** Enchaîne analyse et rédaction, sans revue humaine (banc d'évaluation, scripts). */
export async function runLedgerPipeline(input: LedgerPipelineInput) {
  const analysis = await analyzeSession(input);
  const output = await writeSession(input, analysis);
  return { report: output.report, ledger: analysis, output };
}

// ── Réécriture d'un chapitre (depuis l'éditeur de rapport) ────────────────────

export interface RewriteChapterInput {
  cast: CastSheet;
  sessionHistory: string;
  title: string;
  location?: string;
  allTitles: string[];
  /** Événements du registre du chapitre ; absents pour les rapports d'avant le registre. */
  events: LedgerEvent[];
  /** Transcript nommé du chapitre (« L<n> [Personne] texte »), utilisé quand il n'y a pas de registre. */
  transcriptExcerpt: string;
  instruction?: string;
}

/**
 * Réécrit la narration d'un chapitre. Avec un registre : même rédaction + vérification que le pipeline.
 * Sans registre (anciens rapports) : rédaction depuis le transcript nommé, avec les règles d'attribution.
 */
export async function rewriteChapter(input: RewriteChapterInput): Promise<{ text: string; metadata: Pick<SceneSummary, "keyEvents" | "diceRolls"> | null }> {
  const pipelineInput = {
    cast: input.cast,
    sessionHistory: input.sessionHistory,
  } as LedgerPipelineInput;
  const chapter = {
    title: input.title,
    location: input.location ?? "",
    synopsis: "",
    eventIds: input.events.map((e) => e.id),
    npcs: [],
    technicalNotes: [],
  };
  const index = Math.max(0, input.allTitles.indexOf(input.title));
  const instruction = input.instruction?.trim()
    ? `- Consigne de l'utilisateur (il était à la table, elle prime) : ${input.instruction.trim()}`
    : undefined;

  if (input.events.length) {
    let text = await writeChapter(pipelineInput, chapter, index, input.events, input.allTitles, instruction);
    const check = await verifyChapter(pipelineInput, text, input.events);
    if (check.issues.length) {
      const issues = [instruction, ...check.issues.map((x) => `- « ${x.sentence} » → ${x.problem} : ${x.fix}`)]
        .filter(Boolean)
        .join("\n");
      text = await writeChapter(pipelineInput, chapter, index, input.events, input.allTitles, issues);
    }
    return { text: text.trim(), metadata: eventMetadata(input.events) };
  }

  const text = await generateText({
    task: "writer",
    temperature: 0.5,
    system:
      "Tu es le chroniqueur d'une campagne de jeu de rôle. Tu réécris UN chapitre du compte-rendu, en français, à partir " +
      "de son transcript (les noms de locuteurs viennent d'une diarisation imparfaite : fie-toi au contexte). " +
      "Narration dense au présent, sphères citées, répliques en italique. Ne mentionne jamais le MJ ni les joueurs réels. " +
      "Écris UNIQUEMENT la narration (paragraphes), sans titre ni encadrés.\n\n" + ATTRIBUTION_RULES,
    parts: [
      `CASTING :\n${castText(input.cast)}`,
      input.sessionHistory.trim() ? `EXEMPLE DE STYLE (session précédente) :\n${input.sessionHistory.slice(-15000)}` : "",
      `CHAPITRE : ${input.title}${input.location ? ` — lieu : ${input.location}` : ""}`,
      `TRANSCRIPT DU CHAPITRE :\n${input.transcriptExcerpt}`,
      instruction ?? "",
    ].filter(Boolean),
  });
  return { text: text.trim(), metadata: null };
}
