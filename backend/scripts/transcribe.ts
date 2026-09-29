/**
 * Usage : tsx scripts/transcribe.ts <audio> <out.json> [nbSpeaker] ["initialPrompt"]
 * Envoie un audio au serveur WhisperX et sauvegarde le JSON (segments + mots + locuteurs).
 */
import { writeFile } from "fs/promises";
import { transcribeFile } from "../src/tools/transcription-client.js";

const [audio, out, nb, prompt] = process.argv.slice(2);
if (!audio || !out) {
  console.error("Usage : tsx scripts/transcribe.ts <audio> <out.json> [nbSpeaker] [initialPrompt]");
  process.exit(1);
}

const result = await transcribeFile(audio, {
  nbSpeaker: nb ? Number(nb) : undefined,
  initialPrompt: prompt,
  onProgress: (m) => console.log(`[whisperx] ${m}`),
});
await writeFile(out, JSON.stringify(result, null, 1));
console.log(`OK → ${out} (${result.segments.length} segments)`);
