/**
 * Audit final contre l'audio : Gemini écoute la séance entière et relève les erreurs du CR assemblé
 * (registre faux, embellissements du rédacteur), puis chaque chapitre touché est réécrit avec ces
 * retours et ses encadrés sont réextraits. Pas de revue humaine : l'audio fait foi.
 */
import { resolve } from "path";
import { z } from "zod/v4";
import { audioPart, generateJson, generateText, uploadAudio } from "../config/genai.js";
import { ATTRIBUTION_RULES } from "../config/report-style.js";
import { updateSceneNarrative, type StoredReport } from "../report/editing.js";
import { extractSceneText } from "../tools/transcript-input.js";
import { castText } from "./cast.js";
import { cached, mapLimit, type LedgerPipelineInput, type SessionOutput } from "./ledger-pipeline.js";
import { dictionaryText } from "./name-dictionary.js";

const chapter = z.number().int().describe("numéro N du « Chapitre N » concerné, 0 si hors chapitre (résumé, annexes)");
const time = z.string().describe("horodatage hh:mm:ss dans l'audio");

const AuditSchema = z.object({
  corrections: z.array(
    z.object({
      chapter,
      quote: z.string().describe("citation EXACTE, mot pour mot, du passage fautif du compte rendu"),
      category: z.enum(["attribution", "faits", "noms_propres", "invention", "jeu_hors_jeu", "coherence"]),
      severity: z.enum(["critique", "moyenne", "mineure"]),
      time,
      heard: z.string().describe("ce que dit l'audio, cité"),
      fix: z.string().describe("correction à apporter"),
    })
  ),
  uncertain: z.array(
    z.object({
      chapter,
      quote: z.string().describe("citation exacte du compte rendu concernée, vide si aucune"),
      time,
      heard: z.string().describe("ce que tu entends réellement"),
    })
  ),
  omissions: z.array(z.object({ chapter, time, what: z.string().describe("ce qui manque : scène, révélation, décision, butin…") })),
  summary: z.string().describe("bilan en 3 à 5 lignes : fiabilité globale et erreurs récurrentes"),
});
type Audit = z.infer<typeof AuditSchema>;

const AUDIT_SYSTEM = `Tu es relecteur et auditeur de comptes rendus de séances de jeu de rôle.
On te fournit l'enregistrement audio complet de la séance (source de vérité) et le compte rendu généré automatiquement.
Ta mission : vérifier ce compte rendu contre l'audio et relever TOUTES les erreurs. Ne réécris rien.

Étapes
1. Écoute l'audio en entier avant de juger. Ne te fie pas au texte du CR pour deviner ce qui a été dit.
2. Compare chaque affirmation du CR à l'audio. Pour chaque erreur, donne l'horodatage où l'audio la contredit.
3. Si l'audio est ambigu ou inaudible, ne tranche pas : classe-le en « uncertain » avec ce que tu entends réellement.
4. Une erreur sans preuve audio n'en est pas une.

Erreurs à chercher
- Attribution : mauvais personnage, réplique du MJ attribuée à un joueur, et inversement.
- Faits : événements, ordre, lieux, objets, jets de dés (valeur, compétence, jets distincts fusionnés), dégâts, soins, sorts, décisions, négociations.
- Noms propres : PNJ, lieux, divinités, créatures, sorts ou capacités mal transcrits ; classe ou rôle d'un personnage faux.
- Inventions : éléments du CR absents de l'audio.
- Jeu / hors-jeu : blagues, règles ou pauses prises pour des événements, ou l'inverse.
- Cohérence : contradictions entre passages, ou avec les faits établis de l'univers.
- Omissions : scènes, révélations, décisions, butin ou indices importants absents du CR.

Règles
- « quote » cite le CR MOT POUR MOT (copie exacte, sans reformuler), sinon la correction sera ignorée.
- Une même erreur répétée : une entrée par passage cité.
- Ne relève que ce qui est prouvé par l'audio ; le style et l'ambiance ne sont pas des erreurs.`;

export interface AuditResult extends Audit {
  dropped: { quote: string; reason: string }[];
  rewrittenScenes: number[];
}

// Gemini cite sans le markdown des encadrés (« > - **Nom** — … ») : on l'ignore des deux côtés.
const norm = (s: string) =>
  s.replace(/[*_>]/g, "").replace(/[’‘]/g, "'").replace(/[«»“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** Texte rendu de chaque chapitre (récit + encadrés), indexé par id de scène. */
function chapterSections(output: SessionOutput): Map<number, string> {
  const sections = new Map<number, string>();
  for (const chunk of output.report.split(/^(?=## )/m)) {
    const title = chunk.match(/^## Chapitre \d+\s*:\s*(.+)$/m)?.[1]?.trim();
    const scene = title ? output.workflowState.scenes.find((s) => s.title === title) : undefined;
    if (scene) sections.set(scene.id, norm(chunk));
  }
  return sections;
}

/** Scène visée : celle qui contient la citation, sinon le numéro de chapitre si aucune citation n'est donnée. */
function sceneFor(output: SessionOutput, sections: Map<number, string>, quote: string, chapterNumber: number) {
  if (quote.trim()) {
    const q = norm(quote);
    for (const [id, text] of sections) if (text.includes(q)) return id;
    return undefined;
  }
  return output.workflowState.scenes[chapterNumber - 1]?.id;
}

async function rewriteNarrative(input: LedgerPipelineInput, output: SessionOutput, sceneId: number, notes: string[]) {
  const state = output.workflowState;
  const summary = state.sceneSummaries.find((s) => s.sceneId === sceneId)!;
  const scene = state.scenes.find((s) => s.id === sceneId)!;
  const transcript = extractSceneText(output.preprocessedTranscript, scene.startLine, scene.endLine);
  return generateText({
    task: "edit",
    temperature: 0.2,
    system:
      "Tu corriges le récit d'un chapitre de compte rendu de jeu de rôle après un audit contre l'enregistrement audio, " +
      "qui fait foi. Retourne UNIQUEMENT le récit corrigé, prêt à remplacer l'original.\n" +
      "- Applique toutes les corrections ; quand une erreur porte sur un encadré (jets, notes), écris le bon fait " +
      "dans le récit (ex. la vraie valeur du jet), car les encadrés seront réextraits du récit.\n" +
      "- Intègre les omissions à leur place chronologique, brièvement.\n" +
      "- Points incertains : n'affirme pas le détail douteux, reste neutre.\n" +
      "- Ne change rien d'autre : même style, même longueur, même formatage Markdown.\n\n" +
      ATTRIBUTION_RULES,
    parts: [
      `CASTING :\n${castText(input.cast)}`,
      dictionaryText(state.nameDictionary),
      transcript ? `TRANSCRIPT DE LA SCÈNE (indicatif, l'audit prime) :\n${transcript}` : "",
      `RÉCIT DU CHAPITRE « ${scene.title} » :\n${summary.narrativeSummary}`,
      `RETOURS DE L'AUDIT AUDIO :\n${notes.join("\n")}`,
      "Retourne UNIQUEMENT le récit corrigé.",
    ].filter(Boolean),
  });
}

/** Audite le CR contre l'audio complet puis réécrit les chapitres concernés. Sans audio, rend le CR tel quel. */
export async function auditSession(input: LedgerPipelineInput, output: SessionOutput): Promise<SessionOutput> {
  if (!input.audioPath) return output;
  const progress = input.onProgress ?? (() => {});
  const audioPath = input.audioPath;
  const state = output.workflowState;

  progress("audit");
  const audit = await cached(resolve(input.cacheDir, "audit.json"), async () =>
    generateJson({
      task: "audit",
      temperature: 0,
      schema: AuditSchema,
      system: AUDIT_SYSTEM,
      parts: [
        `CASTING (joueurs → personnages, MJ, PNJ récurrents) :\n${castText(input.cast)}`,
        dictionaryText(state.nameDictionary),
        input.universeContext ? `UNIVERS :\n${input.universeContext}` : "",
        audioPart(await uploadAudio(audioPath)),
        `COMPTE RENDU À AUDITER :\n${output.report}`,
      ].filter(Boolean),
    })
  );

  const sections = chapterSections(output);
  const notes = new Map<number, string[]>();
  const dropped: AuditResult["dropped"] = [];
  const add = (quote: string, chapterNumber: number, note: string) => {
    const id = sceneFor(output, sections, quote, chapterNumber);
    if (id === undefined) dropped.push({ quote: quote || note, reason: quote ? "citation introuvable dans le CR" : "chapitre inconnu" });
    else notes.set(id, [...(notes.get(id) ?? []), note]);
  };
  for (const c of audit.corrections)
    add(c.quote, c.chapter, `- CORRECTION (${c.category}, ${c.severity}) : « ${c.quote} » → ${c.fix} [audio ${c.time} : « ${c.heard} »]`);
  for (const u of audit.uncertain)
    add(u.quote, u.chapter, `- INCERTAIN${u.quote ? ` : « ${u.quote} »` : ""} [audio ${u.time} : ${u.heard}]`);
  for (const o of audit.omissions) add("", o.chapter, `- OMISSION [audio ${o.time}] : ${o.what}`);

  const targets = [...notes.keys()].sort((a, b) => a - b);
  let done = 0;
  const rewritten = await mapLimit(targets, 3, async (sceneId) => {
    const text = (await rewriteNarrative(input, output, sceneId, notes.get(sceneId)!)).trim();
    progress("audit:rewrite", { chapter: ++done, of: targets.length });
    return { sceneId, text };
  });

  // Encadrés réextraits du récit corrigé, scène par scène (chaque appel repart de l'état précédent).
  let stored: StoredReport = {
    reportMd: output.report,
    players: [],
    workflowState: state,
    preprocessedTranscript: output.preprocessedTranscript,
    sessionHistory: input.sessionHistory,
  };
  const rewrittenScenes: number[] = [];
  for (const { sceneId, text } of rewritten) {
    if (!text) continue;
    const updated = await updateSceneNarrative(stored, sceneId, text, input.cast);
    if (!updated) continue;
    stored = { ...stored, reportMd: updated.reportMd, workflowState: updated.workflowState };
    rewrittenScenes.push(sceneId);
  }

  progress("audit:done", { corrections: audit.corrections.length, dropped: dropped.length, scenes: rewrittenScenes.length });
  const result: AuditResult = { ...audit, dropped, rewrittenScenes };
  return {
    ...output,
    report: stored.reportMd,
    workflowState: { ...(stored.workflowState as SessionOutput["workflowState"]), audit: result },
  };
}
