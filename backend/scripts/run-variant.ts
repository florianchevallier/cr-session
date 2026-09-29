/**
 * Génère un CR pour le banc d'évaluation.
 *
 *   tsx scripts/run-variant.ts B   → audio brut envoyé en un seul appel à Gemini
 *   tsx scripts/run-variant.ts C   → nouveau pipeline registre (audio + transcript)
 *
 * Options : --session <id>, --model <gemini-model>, --name <nom de sortie>
 * Sortie : eval/data/results/<nom>.md, à noter ensuite avec eval-attribution.ts judge.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { uploadAudio, audioPart, generateText, trackUsage } from "../src/config/genai.js";
import { transcodeForGemini } from "../src/tools/audio-windows.js";
import { REPORT_FORMAT_INSTRUCTIONS, ATTRIBUTION_RULES } from "../src/config/report-style.js";
import {
  DATA_DIR,
  RESULTS_DIR,
  loadCast,
  loadWhisper,
  castAsText,
  expandHome,
} from "../eval/lib.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const session = flag("session") ?? "mage-session";
const model = flag("model");
const variant = args[0];
const name = flag("name") ?? `${session === "mage-session" ? "" : session + "-"}${variant}${model ? "-" + model : ""}`;

const universeContext = await readFile(resolve("src/config/universes/mage.md"), "utf-8");
// Historique = récap de la session précédente (s'il existe) + CR modèle de style.
const styleExample = await readFile(resolve(DATA_DIR, "style-example.md"), "utf-8");
const historyPath = resolve(DATA_DIR, `${session}.history.md`);
const sessionHistory = existsSync(historyPath)
  ? `${await readFile(historyPath, "utf-8")}\n\n---\n\n${styleExample}`
  : styleExample;
const cast = await loadCast(session);

async function runB(): Promise<string> {
  const mp3 = await transcodeForGemini(expandHome(cast.audio), resolve(DATA_DIR, `${session}.16k.mp3`));
  const audio = await uploadAudio(mp3);
  return generateText({
    task: "audioReport",
    model,
    temperature: 0.4,
    system:
      "Tu écoutes l'enregistrement complet d'une séance de jeu de rôle (table en présentiel, un seul micro) " +
      "et tu en rédiges le compte-rendu narratif. Identifie les voix : le MJ narre et joue les PNJ, chaque joueur " +
      "parle pour son personnage.\n\n" +
      ATTRIBUTION_RULES +
      "\n\n" +
      REPORT_FORMAT_INSTRUCTIONS,
    parts: [
      `CASTING :\n${castAsText(cast)}`,
      `UNIVERS :\n${universeContext}`,
      `COMPTE-RENDU DE LA SESSION PRÉCÉDENTE (contexte ET modèle de style à imiter) :\n${sessionHistory}`,
      audioPart(audio),
      "Rédige le compte-rendu complet de CETTE séance audio.",
    ],
  });
}

async function runC(): Promise<string> {
  const { runLedgerPipeline } = await import("../src/pipeline/ledger-pipeline.js");
  const whisper = await loadWhisper(session);
  const result = await runLedgerPipeline({
    whisper,
    audioPath: expandHome(cast.audio),
    cast,
    universeContext,
    sessionHistory,
    model,
    cacheDir: resolve(RESULTS_DIR, `cache-${name}`),
  });
  await writeFile(resolve(RESULTS_DIR, `${name}.ledger.json`), JSON.stringify(result.ledger, null, 2));
  return result.report;
}

const runners: Record<string, () => Promise<string>> = { B: runB, C: runC };
if (!runners[variant]) {
  console.error("Usage : run-variant.ts B|C [--model m] [--name n] [--session id]");
  process.exit(1);
}

await mkdir(RESULTS_DIR, { recursive: true });
const started = Date.now();
const { result: report, usage } = await trackUsage(runners[variant]);
const out = resolve(RESULTS_DIR, `${name}.md`);
await writeFile(out, report);
const seconds = Math.round((Date.now() - started) / 1000);
await writeFile(resolve(RESULTS_DIR, `${name}.cost.json`), JSON.stringify({ name, session, seconds, ...usage }, null, 2));
console.log(`OK → ${out} (${report.length} caractères, ${seconds} s)`);
console.log(
  `Coût Gemini ≈ $${usage.costUsd.toFixed(3)} — ${usage.calls} appels, ${usage.inputTokens} tokens en entrée, ${usage.outputTokens} en sortie` +
    (usage.unpricedModels.length ? ` (sans tarif : ${usage.unpricedModels.join(", ")})` : "")
);
