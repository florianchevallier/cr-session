import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });

/**
 * Creates a Gemini model instance. Uses Gemini Flash for analysis tasks,
 * Gemini Flash Lite for lighter tasks (summarization, formatting).
 */
export function createModel(
  variant: "pro" | "flash" = "pro",
  temperature = 0.3
): ChatGoogleGenerativeAI {
  const model =
    variant === "pro" ? "gemini-3-flash-preview" : "gemini-flash-lite-latest";
  return new ChatGoogleGenerativeAI({
    model,
    temperature,
    apiKey: process.env.GOOGLE_API_KEY,
  });
}
