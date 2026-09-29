/**
 * Vérifie à l'oreille (Gemini) qui prononce des phrases précises, en comparant à des échantillons
 * de voix pris ailleurs dans la séance.
 *
 *   tsx scripts/voice-check.ts [--model m]
 *
 * Les passages à vérifier sont décrits dans CHECKS ci-dessous (session de référence).
 */
import { resolve } from "path";
import { mkdir } from "fs/promises";
import { z } from "zod/v4";
import { cutAudio, transcodeForGemini } from "../src/tools/audio-windows.js";
import { uploadAudio, audioPart, generateJson } from "../src/config/genai.js";
import { DATA_DIR, loadCast, loadWhisper, expandHome } from "../eval/lib.js";

const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const model = mi >= 0 ? args[mi + 1] : "gemini-3.1-pro-preview";

const VOICES: Record<string, string> = { SPEAKER_00: "Laurent", SPEAKER_01: "Kevin", SPEAKER_02: "Emilie" };

const CHECKS = [
  {
    label: "Ch. 1 — annonce de l'Ancien vampire",
    start: 434,
    end: 460,
    phrases: ["Vous êtes au courant pour l'ancien vampire libéré ?", "Bon, il semblerait qu'il va venir ce soir."],
  },
  {
    label: "Ch. 3 — réécriture des souvenirs (Intelligence + Politique)",
    start: 4040,
    end: 4115,
    phrases: [
      "Je peux imaginer comment il le prendrait si son souvenir c'est d'avoir déglingué tout le monde",
      "Ouais, ouais, ouais. Tout à fait ce que j'ai.",
      "Est-ce que Yeux-Gris il a compris que c'était moi qui manœuvrais",
      "Je vais tenter ça alors. Je remets ce qui s'est passé, mais je m'élimine.",
    ],
  },
  {
    label: "Ch. 6 — plaquage et glissade dans le sang",
    start: 8508,
    end: 8600,
    phrases: [
      "Non mais on ne discute pas, je descends en courant et je vais plaquer le premier",
      "Peut-être que j'essaie de sortir Vayne de là.",
      "Je sais pas ce que c'est le seuil, mais a priori j'ai zéro.",
      "Ok, c'est un échec critique.",
    ],
  },
];

const ResultSchema = z.object({
  phrases: z.array(
    z.object({
      phrase: z.string(),
      speaker: z.string().describe("prénom de la personne qui prononce la phrase, ou 'inaudible'"),
      confidence: z.number(),
      reason: z.string(),
    })
  ),
});

const cast = await loadCast();
const whisper = await loadWhisper();
const work = resolve(DATA_DIR, "voice-check");
await mkdir(work, { recursive: true });
const audio = await transcodeForGemini(expandHome(cast.audio), resolve(DATA_DIR, "mage-session.16k.mp3"));

// Échantillons : 3 segments longs, non mêlés, par voix, loin des passages testés.
const samples: { person: string; path: string }[] = [];
for (const [speaker, person] of Object.entries(VOICES)) {
  const picks = whisper.segments
    .filter((s) => s.speaker === speaker && s.end - s.start >= 5 && s.end - s.start <= 15)
    .filter((s) => new Set((s.words ?? []).map((w) => w.speaker).filter(Boolean)).size <= 1)
    .filter((s) => CHECKS.every((c) => s.end < c.start - 120 || s.start > c.end + 120))
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 3);
  for (const [k, seg] of picks.entries()) {
    const out = resolve(work, `sample-${person}-${k}.mp3`);
    await cutAudio(audio, seg.start, seg.end, out);
    samples.push({ person, path: out });
  }
}

const sampleParts = [];
for (const s of samples) {
  sampleParts.push(`Échantillon de la voix de ${s.person} :`, audioPart(await uploadAudio(s.path)));
}

for (const check of CHECKS) {
  const clip = await cutAudio(audio, check.start, check.end, resolve(work, `check-${check.start}.mp3`));
  const result = await generateJson({
    task: "eval",
    model,
    temperature: 0,
    schema: ResultSchema,
    system:
      "Tu identifies des locuteurs à l'oreille. Tu reçois des échantillons de voix de chaque personne autour d'une table " +
      "de jeu de rôle, puis un extrait. Pour chaque phrase listée, dis QUI la prononce en comparant le timbre, la hauteur et " +
      "le débit aux échantillons. Ne te fie pas au sens des mots : uniquement à la voix.",
    parts: [
      ...sampleParts,
      "EXTRAIT À ANALYSER :",
      audioPart(await uploadAudio(clip)),
      `Phrases à attribuer (${Object.values(VOICES).join(", ")}) :\n${check.phrases.map((p) => `- « ${p} »`).join("\n")}`,
    ],
  });
  console.log(`\n== ${check.label} ==`);
  for (const p of result.phrases) {
    console.log(`  ${p.speaker.padEnd(8)} (${Math.round(p.confidence * 100)} %) « ${p.phrase.slice(0, 70)} » — ${p.reason}`);
  }
}
