/**
 * Tarifs Gemini (USD par million de tokens, palier payant standard, hors batch).
 * Source : https://ai.google.dev/gemini-api/docs/pricing — relevé le 2026-09-29.
 * Surcharge possible via GEMINI_PRICES_JSON = {"modele": {"input": x, "output": y}}.
 */

interface Price {
  input: number;
  output: number;
  /** Tarifs au-delà d'un seuil de taille de prompt (ex. Pro > 200k tokens). */
  above?: { tokens: number; input: number; output: number };
  /** Changement de tarif à une date donnée (ISO). */
  from?: { date: string; input: number; output: number };
}

const PRICES: Record<string, Price> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, from: { date: "2027-01-01", input: 1.5, output: 7.5 } },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, above: { tokens: 200_000, input: 4, output: 18 } },
  "gemini-pro-latest": { input: 2, output: 12, above: { tokens: 200_000, input: 4, output: 18 } },
  "gemini-omni-1.1-flash": { input: 1.5, output: 9 },
};

function overrides(): Record<string, Price> {
  try {
    return process.env.GEMINI_PRICES_JSON ? JSON.parse(process.env.GEMINI_PRICES_JSON) : {};
  } catch {
    return {};
  }
}

/** Coût en USD d'un appel, ou null si le modèle n'a pas de tarif connu. */
export function callCostUsd(model: string, inputTokens: number, outputTokens: number, at = new Date()): number | null {
  const price = overrides()[model] ?? PRICES[model];
  if (!price) return null;
  let { input, output } = price;
  if (price.from && at >= new Date(price.from.date)) ({ input, output } = price.from);
  if (price.above && inputTokens > price.above.tokens) ({ input, output } = price.above);
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}
