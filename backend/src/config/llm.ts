import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });

export type ModelTask =
  | "analyst"
  | "summarizer"
  | "validator"
  | "formatter"
  | "correction";

const DEFAULT_PRO = "gemini-2.5-flash-preview-05-20";
const DEFAULT_FLASH = "gemini-2.0-flash-lite";

const TASK_VARIANT: Record<ModelTask, "pro" | "flash"> = {
  analyst: "pro",
  summarizer: "pro",
  validator: "flash",
  formatter: "pro",
  correction: "pro",
};

function resolveModelName(task: ModelTask): string {
  const taskEnv = process.env[`GEMINI_MODEL_${task.toUpperCase()}`];
  if (taskEnv?.trim()) return taskEnv.trim();

  const variant = TASK_VARIANT[task];
  const variantEnv = process.env[`GEMINI_MODEL_${variant.toUpperCase()}`];
  if (variantEnv?.trim()) return variantEnv.trim();

  return variant === "pro" ? DEFAULT_PRO : DEFAULT_FLASH;
}

export function createModel(
  task: ModelTask,
  temperature = 0.3
): ChatGoogleGenerativeAI {
  const model = resolveModelName(task);
  console.log(`[llm] ${task} → ${model} (t=${temperature})`);
  return new ChatGoogleGenerativeAI({
    model,
    temperature,
    apiKey: process.env.GOOGLE_API_KEY,
  });
}
