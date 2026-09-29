/**
 * Banc d'évaluation « qui fait quoi ».
 *
 *   tsx scripts/eval-attribution.ts gold                 → extrait les affirmations de référence (data/<session>.gold.json)
 *   tsx scripts/eval-attribution.ts judge <cr.md> <nom>   → note un CR contre la référence (data/results/<nom>.json)
 *   tsx scripts/eval-attribution.ts table                 → tableau comparatif de tous les résultats
 *
 * Option : --session <id> (défaut mage-session)
 */
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod/v4";
import { generateJson } from "../src/config/genai.js";
import { DATA_DIR, RESULTS_DIR, loadCast, castAsText } from "../eval/lib.js";

const args = process.argv.slice(2);
const sessionFlag = args.indexOf("--session");
const session = sessionFlag >= 0 ? args.splice(sessionFlag, 2)[1] : "mage-session";
const [command, ...rest] = args;

const JUDGE_MODEL = process.env.GEMINI_MODEL_EVAL?.trim() || "gemini-3.1-pro-preview";

// ── Schémas ──────────────────────────────────────────────────────────────────

const GoldClaim = z.object({
  id: z.string().describe("identifiant court, ex. c1-03"),
  chapter: z.number().int(),
  actor: z.string().describe("personnage qui réalise l'action (nom canonique)"),
  actorType: z.enum(["PJ", "PNJ"]),
  action: z.string().describe("l'action en une phrase courte, sans nommer l'acteur"),
  outcome: z.enum(["réussi", "raté", "tenté", "intention", "neutre"]),
});
const GoldSchema = z.object({ claims: z.array(GoldClaim) });
type Gold = z.infer<typeof GoldSchema>;

const JudgeSchema = z.object({
  goldVerdicts: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["correct", "wrong_actor", "wrong_outcome", "missing"]),
      candidateActor: z.string().describe("acteur que le CR candidat donne à cette action ('' si absent)"),
      quote: z.string().describe("courte citation du CR candidat ('' si absent)"),
    })
  ),
  extraClaims: z.array(
    z.object({
      actor: z.string(),
      action: z.string(),
      verdict: z.enum(["wrong_actor", "not_in_reference", "gm_or_npc_as_pc", "absent_character"]),
      correctActor: z.string().describe("acteur réel selon la référence, '' si inconnu"),
    })
  ),
});
type Judge = z.infer<typeof JudgeSchema>;

// ── Commandes ────────────────────────────────────────────────────────────────

async function buildGold() {
  const cast = await loadCast(session);
  const reference = await readFile(resolve(DATA_DIR, `${session}.reference.md`), "utf-8");
  const gold = await generateJson({
    task: "eval",
    model: JUDGE_MODEL,
    temperature: 0,
    schema: GoldSchema,
    system:
      "Tu construis une vérité terrain d'attribution pour évaluer des comptes-rendus de jeu de rôle. " +
      "Extrais du CR de référence TOUTES les actions significatives, une par affirmation atomique : " +
      "qui (personnage) fait quoi. Inclus chaque jet de dés, chaque sort, chaque action décisive, " +
      "chaque réplique marquante. Couvre les PJ en priorité, et les PNJ quand leur action compte " +
      "(pour détecter les confusions PJ/PNJ). Une action commune (« Marc & Yumi ») donne une affirmation par acteur. " +
      "N'invente rien : uniquement ce que dit la référence.",
    parts: [`CASTING :\n${castAsText(cast)}`, `CR DE RÉFÉRENCE :\n${reference}`],
  });
  const path = resolve(DATA_DIR, `${session}.gold.json`);
  await writeFile(path, JSON.stringify(gold, null, 2));
  const byActor = countBy(gold.claims, (c) => c.actor);
  console.log(`OK → ${path} : ${gold.claims.length} affirmations`, byActor);
}

async function judge(reportPath: string, name: string) {
  const cast = await loadCast(session);
  const goldPath = resolve(DATA_DIR, `${session}.gold.json`);
  if (!existsSync(goldPath)) throw new Error("Lance d'abord : eval-attribution.ts gold");
  const gold: Gold = JSON.parse(await readFile(goldPath, "utf-8"));
  const reference = await readFile(resolve(DATA_DIR, `${session}.reference.md`), "utf-8");
  const candidate = await readFile(reportPath, "utf-8");

  const verdict = await generateJson({
    task: "eval",
    model: JUDGE_MODEL,
    temperature: 0,
    schema: JudgeSchema,
    system:
      "Tu es un correcteur strict. On compare un CR CANDIDAT à une liste d'affirmations de référence " +
      "(vérité terrain : qui fait quoi). Pour CHAQUE affirmation de référence, cherche l'action dans le candidat :\n" +
      "- correct : l'action est présente et attribuée au même personnage (alias acceptés) avec une issue compatible ;\n" +
      "- wrong_actor : l'action est présente mais attribuée à quelqu'un d'autre (ou à « le groupe », « le MJ ») ;\n" +
      "- wrong_outcome : bon acteur mais issue contraire (réussite ↔ échec, intention présentée comme fait) ;\n" +
      "- missing : l'action n'apparaît pas.\n" +
      "Ensuite liste dans extraClaims les actions du candidat faites par un PJ (ou présentées comme telles) qui sont fausses :\n" +
      "- wrong_actor : la référence attribue cette action à un autre personnage ;\n" +
      "- gm_or_npc_as_pc : parole/action du MJ ou d'un PNJ attribuée à un PJ ;\n" +
      "- absent_character : un personnage agit alors qu'il n'est pas dans la scène selon la référence ;\n" +
      "- not_in_reference : action d'un PJ inventée, introuvable dans la référence.\n" +
      "Sois exhaustif et ne sois pas indulgent sur l'identité de l'acteur.",
    parts: [
      `CASTING :\n${castAsText(cast)}`,
      `AFFIRMATIONS DE RÉFÉRENCE :\n${JSON.stringify(gold.claims)}`,
      `CR DE RÉFÉRENCE COMPLET (contexte) :\n${reference}`,
      `CR CANDIDAT :\n${candidate}`,
    ],
  });

  const metrics = computeMetrics(gold, verdict);
  await mkdir(RESULTS_DIR, { recursive: true });
  const out = resolve(RESULTS_DIR, `${name}.json`);
  await writeFile(out, JSON.stringify({ name, session, report: reportPath, metrics, verdict }, null, 2));
  printMetrics(name, metrics);
  const wrong = verdict.goldVerdicts.filter((v) => v.status === "wrong_actor");
  if (wrong.length) {
    console.log("\nMauvais acteur (extraits) :");
    for (const w of wrong.slice(0, 15)) {
      const g = gold.claims.find((c) => c.id === w.id);
      console.log(`  - ${g?.actor} → «${g?.action}» ; candidat : ${w.candidateActor}`);
    }
  }
}

function computeMetrics(gold: Gold, v: Judge) {
  const count = (s: string) => v.goldVerdicts.filter((x) => x.status === s).length;
  const correct = count("correct");
  const wrongActor = count("wrong_actor");
  const wrongOutcome = count("wrong_outcome");
  const missing = count("missing");
  const found = correct + wrongActor + wrongOutcome;
  const pcIds = new Set(gold.claims.filter((c) => c.actorType === "PJ").map((c) => c.id));
  const pcVerdicts = v.goldVerdicts.filter((x) => pcIds.has(x.id) && x.status !== "missing");
  const extras = countBy(v.extraClaims, (e) => e.verdict);
  return {
    goldTotal: gold.claims.length,
    correct,
    wrongActor,
    wrongOutcome,
    missing,
    recall: ratio(found, gold.claims.length),
    attributionAccuracy: ratio(correct + wrongOutcome, found),
    pcAttributionAccuracy: ratio(
      pcVerdicts.filter((x) => x.status !== "wrong_actor").length,
      pcVerdicts.length
    ),
    extraErrors: v.extraClaims.length,
    extras,
  };
}

async function table() {
  if (!existsSync(RESULTS_DIR)) return console.log("Aucun résultat.");
  const files = (await readdir(RESULTS_DIR)).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".ledger.json") && !f.endsWith(".cost.json")
  );
  const rows = (
    await Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(RESULTS_DIR, f), "utf-8"))))
  ).filter((r) => (r.session ?? "mage-session") === session);
  console.log("| variante | rappel | précision attribution | précision PJ | mauvais acteur | issue fausse | erreurs en plus | coût Gemini |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const m = r.metrics;
    const costPath = resolve(RESULTS_DIR, `${r.name}.cost.json`);
    const cost = existsSync(costPath) ? `$${JSON.parse(await readFile(costPath, "utf-8")).costUsd.toFixed(3)}` : "—";
    console.log(
      `| ${r.name} | ${pct(m.recall)} | ${pct(m.attributionAccuracy)} | ${pct(m.pcAttributionAccuracy)} | ${m.wrongActor} | ${m.wrongOutcome} | ${m.extraErrors} | ${cost} |`
    );
  }
}

/** Affirmations de référence contredites par au moins `min` variantes : candidates à une erreur de la référence. */
async function disputes(min = 2) {
  const gold: Gold = JSON.parse(await readFile(resolve(DATA_DIR, `${session}.gold.json`), "utf-8"));
  const files = (await readdir(RESULTS_DIR)).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".ledger.json") && !f.endsWith(".cost.json")
  );
  const runs = (
    await Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(RESULTS_DIR, f), "utf-8"))))
  ).filter((r) => (r.session ?? "mage-session") === session);
  for (const claim of gold.claims) {
    const against = runs
      .map((r) => ({ name: r.name as string, v: (r.verdict as Judge).goldVerdicts.find((x) => x.id === claim.id) }))
      .filter((x) => x.v?.status === "wrong_actor");
    if (against.length < min) continue;
    console.log(`\n[${claim.id}] référence : ${claim.actor} → ${claim.action}`);
    for (const a of against) console.log(`   ${a.name} dit : ${a.v!.candidateActor} — « ${a.v!.quote.slice(0, 140)} »`);
  }
}

// ── Utilitaires ──────────────────────────────────────────────────────────────

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, it) => {
    const k = key(it);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}
const ratio = (a: number, b: number) => (b ? a / b : 0);
const pct = (x: number) => `${(x * 100).toFixed(0)} %`;

function printMetrics(name: string, m: ReturnType<typeof computeMetrics>) {
  console.log(`\n== ${name} ==`);
  console.log(`Affirmations de référence : ${m.goldTotal}`);
  console.log(`Rappel (actions retrouvées)       : ${pct(m.recall)}`);
  console.log(`Précision d'attribution (trouvées): ${pct(m.attributionAccuracy)}`);
  console.log(`Précision d'attribution PJ        : ${pct(m.pcAttributionAccuracy)}`);
  console.log(`correct=${m.correct} wrong_actor=${m.wrongActor} wrong_outcome=${m.wrongOutcome} missing=${m.missing}`);
  console.log(`Erreurs supplémentaires du candidat : ${m.extraErrors}`, m.extras);
}

// ── Entrée ───────────────────────────────────────────────────────────────────

if (command === "gold") await buildGold();
else if (command === "judge" && rest[0] && rest[1]) await judge(resolve(rest[0]), rest[1]);
else if (command === "table") await table();
else if (command === "disputes") await disputes(Number(rest[0] ?? 2));
else {
  console.error("Usage : eval-attribution.ts gold | judge <cr.md> <nom> | table [--session id]");
  process.exit(1);
}
