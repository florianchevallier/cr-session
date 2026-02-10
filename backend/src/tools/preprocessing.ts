/**
 * Preprocessor — code pur, pas de LLM.
 * Nettoie le transcript, numérote les lignes, détecte les patterns de base.
 */

export interface PreprocessedLine {
  lineNumber: number;
  speaker: string | null; // "SPEAKER_00" ou null si untagged
  text: string;
  type: "dialogue" | "narration" | "dice_roll" | "untagged" | "empty";
}

const SPEAKER_RE = /^\[([A-Z_]+\d+)\]\s*(.*)/;
const DICE_RE = /^[\d,\s]+\.?$/; // "4, 5, 6, 7." or "1, 8, 8."
const DICE_INLINE_RE =
  /\b(\d+)\s*[,;]\s*(\d+)(?:\s*[,;]\s*(\d+))+\b/; // jets de dés inline

export function preprocessTranscript(rawText: string): {
  preprocessed: string;
  lines: PreprocessedLine[];
  stats: {
    totalLines: number;
    speakerCounts: Record<string, number>;
    untaggedCount: number;
    diceRollCount: number;
  };
} {
  const rawLines = rawText.split("\n");
  const lines: PreprocessedLine[] = [];
  const speakerCounts: Record<string, number> = {};
  let untaggedCount = 0;
  let diceRollCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].trim();
    if (!raw) {
      lines.push({
        lineNumber: i + 1,
        speaker: null,
        text: "",
        type: "empty",
      });
      continue;
    }

    const speakerMatch = raw.match(SPEAKER_RE);
    if (speakerMatch) {
      const speaker = speakerMatch[1];
      const text = speakerMatch[2].trim();
      speakerCounts[speaker] = (speakerCounts[speaker] || 0) + 1;

      // Detect dice rolls in text
      const isDice = DICE_RE.test(text) || (text.length < 30 && DICE_INLINE_RE.test(text));

      lines.push({
        lineNumber: i + 1,
        speaker,
        text,
        type: isDice ? "dice_roll" : "dialogue",
      });
      if (isDice) diceRollCount++;
    } else {
      // Untagged line
      const isDice = DICE_RE.test(raw);
      if (isDice) diceRollCount++;
      untaggedCount++;

      lines.push({
        lineNumber: i + 1,
        speaker: null,
        text: raw,
        type: isDice ? "dice_roll" : "untagged",
      });
    }
  }

  // Build preprocessed string with line numbers and normalized format
  const preprocessed = lines
    .filter((l) => l.type !== "empty")
    .map((l) => {
      const speakerTag = l.speaker ? `[${l.speaker}]` : "[UNTAGGED]";
      const typeTag = l.type === "dice_roll" ? " 🎲" : "";
      return `L${l.lineNumber} ${speakerTag}${typeTag} ${l.text}`;
    })
    .join("\n");

  const totalLines = lines.filter((l) => l.type !== "empty").length;
  return {
    preprocessed,
    lines,
    stats: {
      totalLines,
      speakerCounts,
      untaggedCount,
      diceRollCount,
    },
  };
}

/**
 * Extract a range of lines from the preprocessed transcript for a scene.
 */
export function extractSceneText(
  preprocessed: string,
  startLine: number,
  endLine: number
): string {
  const lines = preprocessed.split("\n");
  return lines
    .filter((line) => {
      const match = line.match(/^L(\d+)\s/);
      if (!match) return false;
      const num = parseInt(match[1], 10);
      return num >= startLine && num <= endLine;
    })
    .join("\n");
}
