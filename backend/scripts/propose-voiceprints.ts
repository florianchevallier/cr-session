/**
 * Propose des échantillons de voix « à vérifier » depuis une session du banc d'évaluation.
 *
 *   tsx scripts/propose-voiceprints.ts --session <id> --voices <voices.json> [--universe mage]
 *
 * <voices.json> : carte des voix produite par le pipeline registre (cache-<variante>/voices.json).
 * Les échantillons apparaissent dans le panneau « Voix » de l'application, à valider à l'oreille.
 */
import { readFile } from "fs/promises";
import { resolve } from "path";
import { transcodeForGemini } from "../src/tools/audio-windows.js";
import { suggestVoiceClips } from "../src/pipeline/voice-suggestions.js";
import { proposeVoiceprints } from "../src/pipeline/voiceprint-store.js";
import { DATA_DIR, loadCast, loadWhisper, expandHome } from "../eval/lib.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const session = flag("session") ?? "mage-session";
const voicesPath = flag("voices");
const universe = flag("universe") ?? "mage";
if (!voicesPath) {
  console.error("Usage : propose-voiceprints.ts --session <id> --voices <voices.json> [--universe mage]");
  process.exit(1);
}

const cast = await loadCast(session);
const whisper = await loadWhisper(session);
const voiceMap = JSON.parse(await readFile(resolve(voicesPath), "utf-8"));
const people = [...new Set([cast.gm.playerName, ...cast.players.map((p) => p.playerName)])];
const audio = await transcodeForGemini(expandHome(cast.audio), resolve(DATA_DIR, `${session}.16k.mp3`));

const suggestions = suggestVoiceClips(whisper.segments, voiceMap, [], people);
const created = await proposeVoiceprints(universe, audio, suggestions, session);
console.log(`Carte des voix : ${voiceMap.voices.map((v: { speakerId: string; mainPerson: string; share: number }) => `${v.speakerId}=${v.mainPerson} (${Math.round(v.share * 100)} %)`).join(", ")}`);
for (const c of created) console.log(`  + ${c.personName} (${Math.round(c.durationSec ?? 0)} s) — ${c.source}`);
const missing = people.filter((p) => !suggestions.some((s) => s.person === p));
if (missing.length) console.log(`Aucun extrait assez propre pour : ${missing.join(", ")}`);
