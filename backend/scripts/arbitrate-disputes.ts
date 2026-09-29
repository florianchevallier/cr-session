/**
 * Arbitre audio des désaccords « qui a fait quoi » entre la référence et les variantes.
 *
 *   tsx scripts/arbitrate-disputes.ts --session <id> --voices <cache>/voices.json [--min 2] [--model m]
 *
 * 1. Désaccords : affirmations de référence que ≥ min variantes attribuent à un autre acteur.
 * 2. Gemini (texte) retrouve les segments du transcript où l'action se décide.
 * 3. L'extrait est découpé, puis Gemini l'écoute avec des échantillons de voix de chaque personne.
 * 4. Sortie : eval/data/<id>.disputes.md (timestamps, extraits à écouter, verdicts) + JSON.
 */
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { resolve } from "path";
import { z } from "zod/v4";
import { cutAudio, formatClock, transcodeForGemini } from "../src/tools/audio-windows.js";
import { uploadAudio, audioPart, generateJson, trackUsage } from "../src/config/genai.js";
import { suggestVoiceClips } from "../src/pipeline/voice-suggestions.js";
import { castText } from "../src/pipeline/cast.js";
import { DATA_DIR, RESULTS_DIR, loadCast, loadWhisper, expandHome } from "../eval/lib.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const session = flag("session") ?? "mage-session";
const voicesPath = flag("voices");
const min = Number(flag("min") ?? 2);
const model = flag("model") ?? "gemini-3.1-pro-preview";
if (!voicesPath) {
  console.error("Usage : arbitrate-disputes.ts --session <id> --voices <voices.json> [--min 2]");
  process.exit(1);
}

const cast = await loadCast(session);
const whisper = await loadWhisper(session);
const voiceMap = JSON.parse(await readFile(resolve(voicesPath), "utf-8"));
const byVoice = new Map<string, string>(voiceMap.voices.map((v: { speakerId: string; mainPerson: string }) => [v.speakerId, v.mainPerson]));
const segments = whisper.segments.filter((s) => s.text.trim());
const gold = JSON.parse(await readFile(resolve(DATA_DIR, `${session}.gold.json`), "utf-8")).claims as {
  id: string;
  actor: string;
  action: string;
  chapter: number;
}[];

// ── 1. Désaccords ────────────────────────────────────────────────────────────
const runs = (
  await Promise.all(
    (await readdir(RESULTS_DIR))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".ledger.json") && !f.endsWith(".cost.json"))
      .map(async (f) => JSON.parse(await readFile(resolve(RESULTS_DIR, f), "utf-8")))
  )
).filter((r) => (r.session ?? "mage-session") === session);

const disputes = gold
  .map((claim) => {
    const against = runs
      .map((r) => r.verdict.goldVerdicts.find((v: { id: string }) => v.id === claim.id))
      .filter((v) => v?.status === "wrong_actor");
    return { claim, alternatives: [...new Set(against.map((v) => v.candidateActor as string))], count: against.length };
  })
  // Les affirmations déjà tranchées à l'écoute par l'utilisateur ne sont plus discutées.
  .filter((d) => d.count >= min && !(d.claim as { corrected?: boolean }).corrected);
console.log(`${disputes.length} désaccords (≥ ${min} variantes sur ${runs.length})`);

// ── 2. Localisation dans le transcript ───────────────────────────────────────
const transcript = segments
  .map((s, i) => `#${i} [${formatClock(s.start)}] ${byVoice.get(s.speaker ?? "") ?? s.speaker}: ${s.text.trim()}`)
  .join("\n");
const LocateSchema = z.object({
  located: z.array(z.object({ id: z.string(), segIds: z.array(z.number().int()), note: z.string() })),
});

const work = resolve(DATA_DIR, `${session}-disputes`);
await mkdir(work, { recursive: true });
const audio = await transcodeForGemini(expandHome(cast.audio), resolve(DATA_DIR, `${session}.16k.mp3`));

const { result: verdicts, usage } = await trackUsage(async () => {
  const { located } = await generateJson({
    task: "eval",
    model: "gemini-3.8-flash",
    temperature: 0,
    schema: LocateSchema,
    system:
      "Pour chaque action décrite, retrouve dans le transcript les 1 à 8 segments (#id) où elle est annoncée, " +
      "jouée ou résolue (annonce du joueur, jet, réponse du MJ). Les noms de locuteurs viennent d'une diarisation " +
      "imparfaite. Liste vide si l'action est introuvable.",
    parts: [
      `CASTING :\n${castText(cast)}`,
      `ACTIONS :\n${disputes.map((d) => `- ${d.claim.id} : ${d.claim.action} (acteur contesté : ${d.claim.actor} ou ${d.alternatives.join(" / ")})`).join("\n")}`,
      `TRANSCRIPT :\n${transcript}`,
    ],
  });

  // ── 3. Échantillons de voix + écoute ─────────────────────────────────────────
  const people = [...new Set([cast.gm.playerName, ...cast.players.map((p) => p.playerName)])];
  const sampleParts: Parameters<typeof generateJson>[0]["parts"] = [];
  for (const s of suggestVoiceClips(segments, voiceMap, [], people, { perPerson: 1 })) {
    const clip = await cutAudio(audio, s.start, s.end, resolve(work, `voice-${s.person}.mp3`));
    sampleParts.push(`Échantillon de la voix de ${s.person} :`, audioPart(await uploadAudio(clip)));
  }

  const VerdictSchema = z.object({
    actor: z.string().describe("personnage qui réalise vraiment l'action dans la fiction"),
    spokenBy: z.string().describe("personne réelle qui annonce ou joue l'action"),
    confidence: z.number(),
    reason: z.string(),
  });

  const out = [];
  for (const d of disputes) {
    const loc = located.find((l) => l.id === d.claim.id);
    const ids = (loc?.segIds ?? []).filter((i) => segments[i]);
    if (!ids.length) {
      out.push({ ...d, start: null, end: null, clip: null, verdict: null, note: loc?.note ?? "introuvable" });
      continue;
    }
    const start = Math.max(0, segments[Math.min(...ids)].start - 8);
    const end = Math.min(segments[Math.max(...ids)].end + 8, start + 120);
    const clip = await cutAudio(audio, start, end, resolve(work, `${d.claim.id}.mp3`));
    const lines = segments
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.start >= start && s.start <= end)
      .map(({ s, i }) => `#${i} [${formatClock(s.start)}] ${byVoice.get(s.speaker ?? "") ?? s.speaker}: ${s.text.trim()}`);
    const verdict = await generateJson({
      task: "eval",
      model,
      temperature: 0,
      schema: VerdictSchema,
      system:
        "Tu arbitres une question « qui a fait quoi » à une table de jeu de rôle en écoutant l'extrait. Compare les voix " +
        "aux échantillons pour savoir qui parle, puis déduis quel PERSONNAGE agit dans la fiction (un joueur agit pour son " +
        "personnage ; le MJ fait agir les PNJ et les PJ qui lui sont confiés).",
      parts: [
        `CASTING :\n${castText(cast)}`,
        ...sampleParts,
        "EXTRAIT :",
        audioPart(await uploadAudio(clip)),
        `TRANSCRIPT DE L'EXTRAIT (étiquettes indicatives) :\n${lines.join("\n")}`,
        `QUESTION : « ${d.claim.action} » — est-ce ${d.claim.actor} (version de référence) ou ${d.alternatives.join(" / ")} (version des variantes), ou quelqu'un d'autre ?`,
      ],
    });
    out.push({ ...d, start, end, clip, verdict, note: loc?.note ?? "" });
    console.log(`[${d.claim.id}] ${formatClock(start)} réf=${d.claim.actor} variantes=${d.alternatives.join("/")} → ${verdict.actor} (${Math.round(verdict.confidence * 100)} %)`);
  }
  return out;
});

// ── 4. Rapport ────────────────────────────────────────────────────────────────
const rows = verdicts.map((v) => {
  const when = v.start === null ? "—" : `${formatClock(v.start)} → ${formatClock(v.end!)}`;
  const verdict = v.verdict ? `**${v.verdict.actor}** (${Math.round(v.verdict.confidence * 100)} %, voix : ${v.verdict.spokenBy}) — ${v.verdict.reason}` : v.note;
  return `| ${v.claim.id} | ${v.claim.action} | ${v.claim.actor} | ${v.alternatives.join(" / ")} | ${when} | ${verdict} |`;
});
const md = [
  `# Désaccords à arbitrer — ${session}`,
  "",
  `Extraits dans \`${work}\` (un MP3 par ligne, nommé par l'identifiant). Coût de l'arbitrage ≈ $${usage.costUsd.toFixed(3)}.`,
  "",
  "| id | action | référence | variantes | à écouter | verdict à l'oreille (Gemini) |",
  "|---|---|---|---|---|---|",
  ...rows,
].join("\n");
await writeFile(resolve(DATA_DIR, `${session}.disputes.md`), md);
await writeFile(resolve(DATA_DIR, `${session}.disputes.json`), JSON.stringify(verdicts, null, 2));
console.log(`\nOK → eval/data/${session}.disputes.md — coût ≈ $${usage.costUsd.toFixed(3)}`);
