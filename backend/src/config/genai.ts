/**
 * Client Gemini natif (@google/genai), pour ce que LangChain gère mal :
 * upload d'audio via l'API Files, et sorties JSON structurées sur de gros contextes.
 */
import { GoogleGenAI, createPartFromUri, type Part } from "@google/genai";
import { z } from "zod/v4";
import { extname } from "path";
import { AsyncLocalStorage } from "async_hooks";
import { callCostUsd } from "./pricing.js";
import "./env.js";

// ── Suivi de l'usage et du coût ──────────────────────────────────────────────

export interface UsageCall {
  task: GenaiTask;
  model: string;
  inputTokens: number;
  /** Tokens de sortie, réflexion comprise (facturée comme de la sortie). */
  outputTokens: number;
  costUsd: number | null;
}

export interface UsageReport {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Somme des appels au tarif connu ; les modèles sans tarif sont listés dans unpricedModels. */
  costUsd: number;
  unpricedModels: string[];
  byTask: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
}

const usageStore = new AsyncLocalStorage<UsageCall[]>();

/** Exécute fn en comptant tous les appels Gemini qu'il déclenche (y compris en parallèle). */
export async function trackUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: UsageReport }> {
  const calls: UsageCall[] = [];
  const result = await usageStore.run(calls, fn);
  return { result, usage: summarizeUsage(calls) };
}

export function summarizeUsage(calls: UsageCall[]): UsageReport {
  const byTask: UsageReport["byTask"] = {};
  const unpriced = new Set<string>();
  let costUsd = 0;
  for (const c of calls) {
    const t = (byTask[c.task] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    t.calls++;
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    if (c.costUsd === null) unpriced.add(c.model);
    else {
      t.costUsd += c.costUsd;
      costUsd += c.costUsd;
    }
  }
  return {
    calls: calls.length,
    inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
    costUsd,
    unpricedModels: [...unpriced],
    byTask,
  };
}

function recordUsage(
  task: GenaiTask,
  model: string,
  usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined
): void {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  const costUsd = callCostUsd(model, inputTokens, outputTokens);
  usageStore.getStore()?.push({ task, model, inputTokens, outputTokens, costUsd });
  console.log(
    `[genai] ${task} → ${model} in=${inputTokens} out=${outputTokens}${costUsd !== null ? ` ≈ $${costUsd.toFixed(4)}` : ""}`
  );
}

export type GenaiTask = "ledger" | "consolidate" | "writer" | "verifier" | "edit" | "eval" | "audioReport";

const DEFAULT_MODEL = "gemini-3.8-flash";

export function genaiModel(task: GenaiTask): string {
  return (
    process.env[`GEMINI_MODEL_${task.toUpperCase()}`]?.trim() ||
    process.env.GEMINI_MODEL_DEFAULT?.trim() ||
    DEFAULT_MODEL
  );
}

let client: GoogleGenAI | null = null;
export function genai(): GoogleGenAI {
  if (!client) {
    if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY manquant");
    client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  }
  return client;
}

const AUDIO_MIME: Record<string, string> = {
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

export function audioMimeType(path: string): string {
  return AUDIO_MIME[extname(path).toLowerCase()] ?? "audio/mpeg";
}

export interface UploadedAudio {
  uri: string;
  mimeType: string;
  name: string;
}

/** Upload d'un fichier audio via l'API Files, attend l'état ACTIVE. */
export async function uploadAudio(path: string, mimeType = audioMimeType(path)): Promise<UploadedAudio> {
  const ai = genai();
  let file = await ai.files.upload({ file: path, config: { mimeType } });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (file.state === "PROCESSING" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state !== "ACTIVE") throw new Error(`Upload audio: état ${file.state}`);
  return { uri: file.uri!, mimeType: file.mimeType ?? mimeType, name: file.name! };
}

export function audioPart(audio: UploadedAudio): Part {
  return createPartFromUri(audio.uri, audio.mimeType);
}

export interface GenerateJsonOptions<T extends z.ZodType> {
  task: GenaiTask;
  system: string;
  parts: (Part | string)[];
  schema: T;
  temperature?: number;
  model?: string;
  retries?: number;
}

/** Génération JSON validée par Zod, avec relances sur erreur de parsing ou d'API. */
export async function generateJson<T extends z.ZodType>(opts: GenerateJsonOptions<T>): Promise<z.infer<T>> {
  const model = opts.model ?? genaiModel(opts.task);
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" });
  const contents = opts.parts.map((p) => (typeof p === "string" ? { text: p } : p));
  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await genai().models.generateContent({
        model,
        contents: [{ role: "user", parts: contents }],
        config: {
          systemInstruction: opts.system,
          temperature: opts.temperature ?? 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          maxOutputTokens: 65536,
        },
      });
      const text = res.text ?? "";
      recordUsage(opts.task, model, res.usageMetadata);
      return opts.schema.parse(JSON.parse(text));
    } catch (err) {
      lastError = err;
      console.warn(`[genai] ${opts.task} tentative ${attempt + 1} échouée: ${(err as Error).message?.slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Génération texte libre (markdown). */
export async function generateText(opts: Omit<GenerateJsonOptions<z.ZodType>, "schema">): Promise<string> {
  const model = opts.model ?? genaiModel(opts.task);
  const contents = opts.parts.map((p) => (typeof p === "string" ? { text: p } : p));
  const res = await genai().models.generateContent({
    model,
    contents: [{ role: "user", parts: contents }],
    config: { systemInstruction: opts.system, temperature: opts.temperature ?? 0.4, maxOutputTokens: 65536 },
  });
  recordUsage(opts.task, model, res.usageMetadata);
  return res.text ?? "";
}
