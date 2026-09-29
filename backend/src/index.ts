/**
 * Serveur CR Session : API (univers, traitements, rapports, voix) + frontend statique en production.
 */
import "./config/env.js";
import express from "express";
import cors from "cors";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { jobsRouter } from "./routes/jobs.js";
import { reportsRouter } from "./routes/reports.js";
import { universesRouter } from "./routes/universes.js";
import { uploadsRouter } from "./routes/uploads.js";
import { universeVoiceprintsRouter, voiceprintsRouter } from "./routes/voiceprints.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const frontendDistDir = resolve(__dirname, "../../frontend/dist");
const isProduction = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/api/universes", universesRouter);
app.use("/api/universes", universeVoiceprintsRouter);
app.use("/api/voiceprints", voiceprintsRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/reports", reportsRouter);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.GOOGLE_API_KEY,
    hasTranscription: !!process.env.WHISPER_API_URL,
  });
});

if (isProduction && existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(frontendDistDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => res.redirect(process.env.FRONTEND_DEV_URL || "http://localhost:5173"));
}

app.listen(PORT, () => {
  console.log(`🎲 CR Session backend sur http://localhost:${PORT}`);
  console.log(`   Gemini : ${process.env.GOOGLE_API_KEY ? "✅" : "❌ GOOGLE_API_KEY manquante"}`);
  console.log(`   WhisperX : ${process.env.WHISPER_API_URL ? "✅" : "❌ WHISPER_API_URL manquante (audio désactivé)"}`);
});
