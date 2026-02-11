import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { buildWorkflow } from "./graph/workflow.js";
import {
  getEditorDraft,
  upsertEditorDraft,
  migrateEditorDraftsFromDisk,
  insertReport,
  updateReportMd,
  updateReportWorkflowState,
  getReport,
  listReports,
  deleteReport,
  insertCorrection,
  listCorrections,
} from "./config/database.js";
import { createModel } from "./config/llm.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../.env") });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

type SceneMeta = {
  id: number;
  type: string;
  title: string;
  startLine: number;
  endLine: number;
};

type UniverseConfig = {
  id: string;
  label: string;
  defaultPrompt: string;
};

const bundledUniversesDir = resolve(__dirname, "config/universes");
const customUniversesDir = resolve(__dirname, "..", "data", "universes");
const editorDraftsDir = resolve(__dirname, "..", "data", "editor-drafts");
const frontendDistDir = resolve(__dirname, "../../frontend/dist");
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));
}

// Migrate disk-based editor drafts to SQLite on first startup
migrateEditorDraftsFromDisk();

function safeUniverseId(id: string): string | null {
  if (!id || typeof id !== "string") return null;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return slug.length > 0 ? slug : null;
}

function getDraftPath(universeId: string): string {
  return join(editorDraftsDir, `${universeId}.json`);
}

type PlayerDraft = {
  playerName: string;
  characterName: string;
  speakerHint?: string;
};

type EditorDraft = {
  universeContext: string;
  sessionHistory: string;
  defaultPlayers?: PlayerDraft[];
};

function parsePlayerDraft(value: unknown): PlayerDraft | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const playerName = typeof o.playerName === "string" ? o.playerName : "";
  const characterName = typeof o.characterName === "string" ? o.characterName : "";
  if (!playerName.trim() && !characterName.trim()) return null;
  return {
    playerName: playerName.trim(),
    characterName: characterName.trim(),
    speakerHint: typeof o.speakerHint === "string" ? o.speakerHint : undefined,
  };
}

function readEditorDraft(universeId: string): EditorDraft | null {
  const safe = safeUniverseId(universeId);
  if (!safe) return null;
  const row = getEditorDraft(safe);
  if (!row) return null;
  return {
    universeContext: row.universeContext,
    sessionHistory: row.sessionHistory,
    defaultPlayers: row.defaultPlayers as PlayerDraft[] | undefined,
  };
}

function writeEditorDraft(universeId: string, draft: EditorDraft): void {
  const safe = safeUniverseId(universeId);
  if (!safe) return;
  upsertEditorDraft(safe, {
    universeContext: draft.universeContext,
    sessionHistory: draft.sessionHistory,
    defaultPlayers: draft.defaultPlayers,
  });
}

function readUniverseDirectory(dirPath: string): UniverseConfig[] {
  if (!existsSync(dirPath)) return [];
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
  return files.map((f) => {
    const id = f.replace(".md", "");
    const content = readFileSync(join(dirPath, f), "utf-8");
    const titleMatch = content.match(/^#\s+(.+)/m);
    return {
      id,
      label: titleMatch ? titleMatch[1] : id,
      defaultPrompt: content,
    };
  });
}

function readUniverses(): UniverseConfig[] {
  // Load bundled universes first, then custom universes (custom overrides same id).
  const ordered = [
    ...readUniverseDirectory(bundledUniversesDir),
    ...readUniverseDirectory(customUniversesDir),
  ];
  const byId = new Map<string, UniverseConfig>();
  for (const universe of ordered) {
    byId.set(universe.id, universe);
  }
  return [...byId.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "fr", { sensitivity: "base" })
  );
}

function universeExists(universeId: string): boolean {
  return (
    existsSync(join(customUniversesDir, `${universeId}.md`)) ||
    existsSync(join(bundledUniversesDir, `${universeId}.md`))
  );
}

function slugifyUniverseId(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// ── List available universes ─────────────────────────────────────────────────

app.get("/api/universes", (_req, res) => {
  try {
    res.json(readUniverses());
  } catch {
    res.json([]);
  }
});

app.post("/api/universes", (req, res) => {
  const label =
    typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const defaultPrompt =
    typeof req.body?.defaultPrompt === "string" ? req.body.defaultPrompt : "";
  const requestedId =
    typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const universeId = slugifyUniverseId(requestedId || label);

  if (!label) {
    res.status(400).json({ message: "Le nom de l'univers est requis." });
    return;
  }

  if (!defaultPrompt.trim()) {
    res
      .status(400)
      .json({ message: "Le contenu du pre-prompt/lore est requis." });
    return;
  }

  if (!universeId) {
    res.status(400).json({
      message:
        "Nom d'univers invalide. Utilise des lettres/chiffres pour generer un identifiant.",
    });
    return;
  }

  if (universeExists(universeId)) {
    res.status(409).json({
      message: `Un univers avec l'identifiant "${universeId}" existe deja.`,
    });
    return;
  }

  const fileContent = defaultPrompt.trimStart().startsWith("#")
    ? defaultPrompt
    : `# ${label}\n\n${defaultPrompt.trim()}\n`;

  try {
    mkdirSync(customUniversesDir, { recursive: true });
    const filePath = join(customUniversesDir, `${universeId}.md`);
    writeFileSync(filePath, fileContent, {
      encoding: "utf-8",
      flag: "wx",
    });

    const titleMatch = fileContent.match(/^#\s+(.+)/m);
    res.status(201).json({
      id: universeId,
      label: titleMatch ? titleMatch[1] : label,
      defaultPrompt: fileContent,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST"
    ) {
      res.status(409).json({
        message: `Un univers avec l'identifiant "${universeId}" existe deja.`,
      });
      return;
    }

    res
      .status(500)
      .json({ message: "Impossible de creer le fichier univers." });
  }
});

// ── Editor draft (pre-prompt / lore + session history) persisted on disk ─────

app.get("/api/universes/:id/draft", (req, res) => {
  const universeId = safeUniverseId(req.params.id ?? "");
  if (!universeId) {
    res.status(400).json({ message: "Identifiant univers invalide." });
    return;
  }
  const draft = readEditorDraft(universeId);
  if (!draft) {
    res.status(404).json({ message: "Aucun brouillon enregistre pour cet univers." });
    return;
  }
  res.json(draft);
});

app.put("/api/universes/:id/draft", (req, res) => {
  const universeId = safeUniverseId(req.params.id ?? "");
  if (!universeId) {
    res.status(400).json({ message: "Identifiant univers invalide." });
    return;
  }
  const universeContext =
    typeof req.body?.universeContext === "string" ? req.body.universeContext : "";
  const sessionHistory =
    typeof req.body?.sessionHistory === "string" ? req.body.sessionHistory : "";
  const defaultPlayers: PlayerDraft[] = [];
  if (Array.isArray(req.body?.defaultPlayers)) {
    for (const item of req.body.defaultPlayers) {
      const p = parsePlayerDraft(item);
      if (p) defaultPlayers.push(p);
    }
  }
  const draft: EditorDraft = {
    universeContext,
    sessionHistory,
    defaultPlayers: defaultPlayers.length > 0 ? defaultPlayers : undefined,
  };
  try {
    writeEditorDraft(universeId, draft);
    res.json({ universeContext, sessionHistory, defaultPlayers: draft.defaultPlayers });
  } catch {
    res
      .status(500)
      .json({ message: "Impossible d'enregistrer le brouillon." });
  }
});

// ── Logging ───────────────────────────────────────────────────────────────────

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

type ProcessJobStatus = "pending" | "running" | "completed" | "failed";

type ProcessInput = {
  rawTranscript: string;
  transcriptName: string;
  universeContext: string;
  sessionHistory: string;
  universeName: string;
  playerInfo: PlayerDraft[];
};

type ProcessJobEvent = {
  id: number;
  type: string;
  data: unknown;
  timestamp: string;
};

type ProcessJob = {
  id: string;
  status: ProcessJobStatus;
  createdAt: string;
  updatedAt: string;
  transcriptName: string;
  universeName: string;
  playerInfo: PlayerDraft[];
  input: ProcessInput;
  events: ProcessJobEvent[];
  listeners: Set<(event: ProcessJobEvent) => void>;
  nextEventId: number;
  error: string | null;
};

type ProcessJobSummary = {
  id: string;
  status: ProcessJobStatus;
  createdAt: string;
  updatedAt: string;
  transcriptName: string;
  universeName: string;
  playersCount: number;
  error: string | null;
};

type ParsedProcessRequest =
  | { ok: true; input: ProcessInput }
  | { ok: false; status: number; message: string };

const processJobs = new Map<string, ProcessJob>();
const PROCESS_JOB_RETENTION_MS = 6 * 60 * 60 * 1000;

function isTerminalJobStatus(status: ProcessJobStatus): boolean {
  return status === "completed" || status === "failed";
}

function toProcessJobSummary(job: ProcessJob): ProcessJobSummary {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    transcriptName: job.transcriptName,
    universeName: job.universeName,
    playersCount: job.playerInfo.length,
    error: job.error,
  };
}

function cleanupProcessJobs(): void {
  const now = Date.now();
  for (const [id, job] of processJobs.entries()) {
    if (!isTerminalJobStatus(job.status)) continue;
    const age = now - new Date(job.updatedAt).getTime();
    if (age > PROCESS_JOB_RETENTION_MS) {
      processJobs.delete(id);
    }
  }
}

function createProcessJob(input: ProcessInput): ProcessJob {
  cleanupProcessJobs();
  const now = new Date().toISOString();
  const job: ProcessJob = {
    id: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    transcriptName: input.transcriptName,
    universeName: input.universeName,
    playerInfo: input.playerInfo,
    input,
    events: [],
    listeners: new Set(),
    nextEventId: 1,
    error: null,
  };
  processJobs.set(job.id, job);
  return job;
}

function setProcessJobStatus(
  job: ProcessJob,
  status: ProcessJobStatus,
  error: string | null = null
): void {
  job.status = status;
  job.error = error;
  job.updatedAt = new Date().toISOString();
}

function publishProcessJobEvent(
  job: ProcessJob,
  type: string,
  data: unknown
): void {
  const event: ProcessJobEvent = {
    id: job.nextEventId++,
    type,
    data,
    timestamp: new Date().toISOString(),
  };
  job.events.push(event);
  job.updatedAt = event.timestamp;
  for (const listener of [...job.listeners]) {
    listener(event);
  }
}

function initSSE(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSSEEvent(
  res: Response,
  type: string,
  data: unknown,
  id?: number
): void {
  if (typeof id === "number") {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamProcessJob(
  req: Request,
  res: Response,
  job: ProcessJob,
  fromEventId = 0
): void {
  initSSE(res);
  for (const event of job.events) {
    if (event.id >= fromEventId) {
      writeSSEEvent(res, event.type, event.data, event.id);
    }
  }

  if (isTerminalJobStatus(job.status)) {
    res.end();
    return;
  }

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let listener: ((event: ProcessJobEvent) => void) | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (listener) job.listeners.delete(listener);
    if (!res.writableEnded) {
      res.end();
    }
  };

  listener = (event: ProcessJobEvent) => {
    writeSSEEvent(res, event.type, event.data, event.id);
    if (isTerminalJobStatus(job.status)) {
      cleanup();
    }
  };
  job.listeners.add(listener);

  heartbeat = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 15_000);

  req.on("close", cleanup);
  res.on("close", cleanup);
}

function parseProcessRequest(req: Request): ParsedProcessRequest {
  const transcriptText =
    req.file?.buffer.toString("utf-8") ??
    (typeof req.body?.transcript === "string" ? req.body.transcript : "");

  if (!transcriptText.trim()) {
    return { ok: false, status: 400, message: "Aucun transcript fourni." };
  }

  const universeContext =
    typeof req.body?.universeContext === "string" ? req.body.universeContext : "";
  const sessionHistory =
    typeof req.body?.sessionHistory === "string" ? req.body.sessionHistory : "";
  const universeName =
    typeof req.body?.universeName === "string" && req.body.universeName.trim()
      ? req.body.universeName.trim()
      : "generic";
  const transcriptNameFromBody =
    typeof req.body?.transcriptName === "string" ? req.body.transcriptName : "";
  const transcriptName =
    req.file?.originalname?.trim() ||
    transcriptNameFromBody.trim() ||
    "transcript.txt";

  let parsedPlayerInfo: unknown = req.body?.playerInfo ?? [];
  if (typeof parsedPlayerInfo === "string") {
    try {
      parsedPlayerInfo = JSON.parse(parsedPlayerInfo);
    } catch {
      return {
        ok: false,
        status: 400,
        message: "playerInfo invalide (JSON attendu).",
      };
    }
  }

  if (!Array.isArray(parsedPlayerInfo)) {
    return {
      ok: false,
      status: 400,
      message: "playerInfo invalide (tableau attendu).",
    };
  }

  const players = parsedPlayerInfo
    .map((value) => parsePlayerDraft(value))
    .filter((p): p is PlayerDraft => p !== null);

  return {
    ok: true,
    input: {
      rawTranscript: transcriptText,
      transcriptName,
      universeContext,
      sessionHistory,
      universeName,
      playerInfo: players,
    },
  };
}

async function runProcessJob(job: ProcessJob): Promise<void> {
  const input = {
    rawTranscript: job.input.rawTranscript,
    universeContext: job.input.universeContext,
    sessionHistory: job.input.sessionHistory,
    universeName: job.input.universeName,
    playerInfo: job.input.playerInfo,
  };

  setProcessJobStatus(job, "running");
  log("Démarrage workflow", {
    jobId: job.id,
    transcriptLength: input.rawTranscript.length,
    lines: input.rawTranscript.split("\n").length,
    universe: input.universeName,
    playersCount: input.playerInfo.length,
  });

  publishProcessJobEvent(job, "step:start", {
    step: "preprocessor",
    label: "Preprocessing du transcript...",
  });

  try {
    const workflow = buildWorkflow();
    const stream = await workflow.stream(input, {
      streamMode: ["updates", "custom"],
    });

    let narrativeScenesCache: SceneMeta[] = [];

    const sendSceneCollection = (
      group: "summarizer" | "validator",
      scenes: SceneMeta[]
    ) => {
      publishProcessJobEvent(job, "step:scenes", {
        group,
        scenes: scenes.map((s) => ({
          id: s.id,
          title: s.title,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
      });
    };

    const handleCustomChunk = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const custom = payload as { event?: unknown; payload?: unknown };
      if (
        typeof custom.event === "string" &&
        custom.payload &&
        typeof custom.payload === "object"
      ) {
        publishProcessJobEvent(job, custom.event, custom.payload);
      }
    };

    const handleUpdateChunk = (update: Record<string, unknown>) => {
      for (const [nodeName, nodeOutput] of Object.entries(update)) {
        const output = nodeOutput as Record<string, unknown>;
        switch (nodeName) {
          case "preprocessor":
            log("Étape terminée: preprocessor", { jobId: job.id });
            publishProcessJobEvent(job, "step:complete", {
              step: "preprocessor",
              label: "Preprocessing terminé",
            });
            publishProcessJobEvent(job, "step:start", {
              step: "analyst",
              label: "Analyse du transcript (détection scènes, speakers, entités)...",
            });
            break;

          case "analyst": {
            const scenes = (output.scenes as SceneMeta[]) || [];
            const narrativeScenes = scenes.filter(
              (s) => s.type !== "meta" && s.type !== "pause"
            );
            narrativeScenesCache = narrativeScenes;
            log("Étape terminée: analyst", {
              jobId: job.id,
              scenesCount: scenes.length,
              narrativeScenesCount: narrativeScenes.length,
            });

            publishProcessJobEvent(job, "step:complete", {
              step: "analyst",
              label: "Analyse terminée",
              data: {
                scenesCount: scenes.length,
                narrativeScenesCount: narrativeScenes.length,
                speakerMap: output.speakerMap,
                entitiesPreview: output.entities,
              },
            });
            publishProcessJobEvent(job, "step:start", {
              step: "summarizer",
              label:
                "Analyse détaillée des scènes (en parallèle, subset transcript par agent)",
              data: { totalScenes: narrativeScenes.length },
            });
            sendSceneCollection("summarizer", narrativeScenes);
            break;
          }

          case "summarizer": {
            const summariesCount = (output.sceneSummaries as unknown[])?.length ?? 0;
            log("Étape terminée: summarizer", { jobId: job.id, summariesCount });
            publishProcessJobEvent(job, "step:complete", {
              step: "summarizer",
              label: `Analyse terminée (${summariesCount} scène(s) traitée(s))`,
              data: { summariesCount },
            });

            publishProcessJobEvent(job, "step:start", {
              step: "validator",
              label: "Validation détaillée par scène en cours...",
            });
            sendSceneCollection("validator", narrativeScenesCache);
            break;
          }

          case "validator": {
            const report = output.validationReport as {
              isValid: boolean;
              issues: unknown[];
            };
            const retryCount = output.retryCount as number;
            log("Étape terminée: validator", {
              jobId: job.id,
              isValid: report?.isValid,
              issuesCount: report?.issues?.length ?? 0,
              retryCount,
            });

            publishProcessJobEvent(job, "step:complete", {
              step: "validator",
              label: report?.isValid
                ? "Validation OK"
                : `Validation: ${report?.issues?.length || 0} problème(s) détecté(s)`,
              data: { validationReport: report, retryCount },
            });

            const errorSceneIds = [
              ...new Set(
                (report?.issues || [])
                  .filter((issue) => {
                    if (!issue || typeof issue !== "object") return false;
                    const severity = (issue as { severity?: unknown }).severity;
                    const sceneId = (issue as { sceneId?: unknown }).sceneId;
                    return severity === "error" && typeof sceneId === "number";
                  })
                  .map((issue) => (issue as { sceneId: number }).sceneId)
              ),
            ];

            if (
              report &&
              !report.isValid &&
              retryCount < 2 &&
              errorSceneIds.length > 0
            ) {
              const retryScenes = narrativeScenesCache.filter((s) =>
                errorSceneIds.includes(s.id)
              );

              publishProcessJobEvent(job, "step:start", {
                step: "summarizer",
                label: `Correction parallèle des ${retryScenes.length} scène(s) en erreur (tentative ${retryCount + 1})...`,
                data: { totalScenes: retryScenes.length, retryCount },
              });
              sendSceneCollection("summarizer", retryScenes);
            } else {
              publishProcessJobEvent(job, "step:start", {
                step: "formatter",
                label: "Mise en forme du compte-rendu...",
              });
            }
            break;
          }

          case "formatter": {
            const finalReport = output.finalReport as string;
            log("Étape terminée: formatter", {
              jobId: job.id,
              reportLength:
                typeof finalReport === "string" ? finalReport.length : 0,
            });
            publishProcessJobEvent(job, "step:complete", {
              step: "formatter",
              label: "Compte-rendu généré !",
            });

            // Save report and workflow state to SQLite
            const reportId = randomUUID();
            try {
              insertReport({
                id: reportId,
                jobId: job.id,
                reportMd: finalReport,
                universeName: job.universeName,
                transcriptName: job.transcriptName,
                players: job.playerInfo,
                workflowState: output as Record<string, unknown>,
              });
              log("Report saved to SQLite", { reportId, jobId: job.id });
            } catch (dbErr) {
              log("Failed to save report to SQLite", {
                jobId: job.id,
                error: dbErr instanceof Error ? dbErr.message : String(dbErr),
              });
            }

            publishProcessJobEvent(job, "result", {
              reportId,
              finalReport: output.finalReport,
              scenes: output.scenes,
              entities: output.entities,
              job: {
                id: job.id,
                universeName: job.universeName,
                transcriptName: job.transcriptName,
                playerInfo: job.playerInfo,
              },
            });
            break;
          }
        }
      }
    };

    for await (const chunk of stream) {
      if (Array.isArray(chunk) && chunk.length === 2) {
        const [mode, payload] = chunk as [string, unknown];
        if (mode === "custom") {
          handleCustomChunk(payload);
          continue;
        }
        if (mode === "updates" && payload && typeof payload === "object") {
          handleUpdateChunk(payload as Record<string, unknown>);
        }
        continue;
      }

      if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
        handleUpdateChunk(chunk as Record<string, unknown>);
      }
    }

    setProcessJobStatus(job, "completed");
    log("Workflow terminé avec succès", { jobId: job.id });
    publishProcessJobEvent(job, "done", { message: "Traitement terminé." });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur interne du serveur";
    setProcessJobStatus(job, "failed", message);
    log("Workflow en erreur", {
      jobId: job.id,
      message,
    });
    console.error("Workflow error:", error);
    publishProcessJobEvent(job, "error", {
      message,
      stack:
        process.env.NODE_ENV === "development" && error instanceof Error
          ? error.stack
          : undefined,
    });
  } finally {
    cleanupProcessJobs();
  }
}

// ── Reports (SQLite-backed) ──────────────────────────────────────────────────

app.get("/api/reports", (_req, res) => {
  try {
    const reports = listReports();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ message: "Erreur lors de la lecture des rapports." });
  }
});

app.get("/api/reports/:id", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }
  // Don't send workflow state in the detail response (too large)
  const { workflowState, ...rest } = report;
  res.json(rest);
});

app.get("/api/reports/:id/full", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }
  res.json(report);
});

app.delete("/api/reports/:id", (req, res) => {
  const deleted = deleteReport(req.params.id);
  if (!deleted) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }
  res.json({ message: "Rapport supprimé." });
});

app.get("/api/reports/:id/corrections", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }
  const corrections = listCorrections(req.params.id);
  res.json(corrections);
});

app.post("/api/reports/:id/correct", async (req, res) => {
  const reportId = req.params.id;
  const report = getReport(reportId);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }

  const selectedText =
    typeof req.body?.selectedText === "string" ? req.body.selectedText.trim() : "";
  const instruction =
    typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";

  if (!selectedText) {
    res.status(400).json({ message: "Texte sélectionné requis." });
    return;
  }
  if (!instruction) {
    res.status(400).json({ message: "Instruction de correction requise." });
    return;
  }

  try {
    const model = createModel("pro", 0.15);

    const currentReport = report.reportMd;
    const previousReport = currentReport;

    const correctionResponse = await model.invoke([
      new SystemMessage(
        `Tu es un expert en édition de comptes-rendus de JDR au format Markdown.\n\n` +
        `## Ta mission\n` +
        `On te donne un compte-rendu Markdown complet et une demande de correction ciblée.\n` +
        `Tu dois appliquer la correction demandée en modifiant UNIQUEMENT la partie concernée.\n\n` +
        `## Règles\n` +
        `- Retourne le compte-rendu Markdown COMPLET avec la correction appliquée\n` +
        `- Ne modifie QUE ce qui est demandé, garde tout le reste strictement identique\n` +
        `- Conserve le même style, la même structure, le même formatage Markdown\n` +
        `- Si la correction concerne l'attribution d'une action (qui a fait quoi), sois précis\n` +
        `- Ne supprime jamais de contenu sauf si explicitement demandé\n` +
        `- Ne rajoute pas de contenu non demandé\n`
      ),
      new HumanMessage(
        `## Compte-rendu actuel\n\n${currentReport}\n\n` +
        `## Passage sélectionné par l'utilisateur\n\n"${selectedText}"\n\n` +
        `## Correction demandée\n\n${instruction}\n\n` +
        `Retourne le compte-rendu complet avec la correction appliquée. Uniquement le Markdown, rien d'autre.`
      ),
    ]);

    const correctedReport =
      typeof correctionResponse.content === "string"
        ? correctionResponse.content
        : JSON.stringify(correctionResponse.content);

    // Save the correction and update the report
    const correctionId = randomUUID();
    insertCorrection({
      id: correctionId,
      reportId,
      selectedText,
      instruction,
      previousReportMd: previousReport,
    });
    updateReportMd(reportId, correctedReport);

    log("Correction applied", { reportId, correctionId });

    res.json({
      reportId,
      correctionId,
      reportMd: correctedReport,
    });
  } catch (err) {
    log("Correction error", {
      reportId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      message: err instanceof Error ? err.message : "Erreur lors de la correction.",
    });
  }
});

// ── Process jobs (in-memory queue + resumable SSE) ───────────────────────────

app.post("/api/jobs", upload.single("transcript"), (req, res) => {
  const parsed = parseProcessRequest(req);
  if (!parsed.ok) {
    res.status(parsed.status).json({ message: parsed.message });
    return;
  }

  const job = createProcessJob(parsed.input);
  void runProcessJob(job);
  res.status(202).json(toProcessJobSummary(job));
});

app.get("/api/jobs", (req, res) => {
  cleanupProcessJobs();
  const allowedStatuses: ProcessJobStatus[] = [
    "pending",
    "running",
    "completed",
    "failed",
  ];
  const queryStatus = typeof req.query.status === "string" ? req.query.status : "";
  const requestedStatuses = queryStatus
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ProcessJobStatus =>
      allowedStatuses.includes(s as ProcessJobStatus)
    );

  const jobs = [...processJobs.values()]
    .filter((job) =>
      requestedStatuses.length > 0 ? requestedStatuses.includes(job.status) : true
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => toProcessJobSummary(job));
  res.json(jobs);
});

app.get("/api/jobs/:id", (req, res) => {
  cleanupProcessJobs();
  const job = processJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job introuvable." });
    return;
  }
  res.json(toProcessJobSummary(job));
});

app.get("/api/jobs/:id/stream", (req, res) => {
  cleanupProcessJobs();
  const job = processJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job introuvable." });
    return;
  }
  const rawFrom = typeof req.query.from === "string" ? req.query.from : "0";
  const from = Number.parseInt(rawFrom, 10);
  const fromEventId = Number.isFinite(from) && from >= 0 ? from : 0;
  streamProcessJob(req, res, job, fromEventId);
});

// ── Backward compatibility: old /api/process SSE route ───────────────────────

app.post("/api/process", upload.single("transcript"), (req, res) => {
  log("POST /api/process reçu");
  const parsed = parseProcessRequest(req);
  if (!parsed.ok) {
    initSSE(res);
    writeSSEEvent(res, "error", { message: parsed.message });
    res.end();
    return;
  }

  const job = createProcessJob(parsed.input);
  void runProcessJob(job);
  streamProcessJob(req, res, job, 0);
});

// ── Health check ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", hasApiKey: !!process.env.GOOGLE_API_KEY });
});

if (isProduction && existsSync(frontendDistDir)) {
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(join(frontendDistDir, "index.html"));
  });
}

// ── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎲 CR Session backend running on http://localhost:${PORT}`);
  console.log(
    `   API key: ${process.env.GOOGLE_API_KEY ? "✅ configured" : "❌ missing"}`
  );
});
