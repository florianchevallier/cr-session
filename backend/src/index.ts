import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { buildWorkflow } from "./graph/workflow.js";
import { extractSceneText } from "./tools/preprocessing.js";
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
import { z } from "zod";

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
  location?: string;
  summary?: string;
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
const frontendDevUrl = process.env.FRONTEND_DEV_URL || "http://localhost:5173";

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
  characterDetails?: string;
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
    characterDetails:
      typeof o.characterDetails === "string" && o.characterDetails.trim()
        ? o.characterDetails.trim()
        : undefined,
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

type ValidationIssueLog = {
  sceneId?: number;
  issue: string;
  severity: "error" | "warning" | "info";
  suggestion?: string;
};
const CORRECTION_LOG_PREVIEW_MAX_LENGTH = 280;

function toSingleLinePreview(
  value: string,
  maxLength = CORRECTION_LOG_PREVIEW_MAX_LENGTH
): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function parseValidationIssues(value: unknown): ValidationIssueLog[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const issue = item as Record<string, unknown>;
    const severity = issue.severity;
    const issueText = typeof issue.issue === "string" ? issue.issue : "";
    if (
      (severity !== "error" && severity !== "warning" && severity !== "info") ||
      !issueText
    ) {
      return [];
    }
    return [
      {
        sceneId: typeof issue.sceneId === "number" ? issue.sceneId : undefined,
        issue: issueText,
        severity,
        suggestion:
          typeof issue.suggestion === "string" ? issue.suggestion : undefined,
      },
    ];
  });
}

function summarizeValidationIssues(issues: ValidationIssueLog[]): {
  issuesCount: number;
  errorsCount: number;
  warningsCount: number;
  infosCount: number;
  errorSceneIds: number[];
  sceneBreakdown: Array<{ sceneId: number; issuesCount: number; errorsCount: number }>;
} {
  const byScene = new Map<number, ValidationIssueLog[]>();
  for (const issue of issues) {
    if (typeof issue.sceneId !== "number") continue;
    const sceneIssues = byScene.get(issue.sceneId) ?? [];
    sceneIssues.push(issue);
    byScene.set(issue.sceneId, sceneIssues);
  }

  const errorSceneIds = [...new Set(
    issues
      .filter((issue) => issue.severity === "error" && issue.sceneId != null)
      .map((issue) => issue.sceneId!)
  )];

  return {
    issuesCount: issues.length,
    errorsCount: issues.filter((issue) => issue.severity === "error").length,
    warningsCount: issues.filter((issue) => issue.severity === "warning").length,
    infosCount: issues.filter((issue) => issue.severity === "info").length,
    errorSceneIds,
    sceneBreakdown: [...byScene.entries()]
      .map(([sceneId, sceneIssues]) => ({
        sceneId,
        issuesCount: sceneIssues.length,
        errorsCount: sceneIssues.filter((i) => i.severity === "error").length,
      }))
      .sort((a, b) => a.sceneId - b.sceneId),
  };
}

function extractSectionContaining(
  report: string,
  selectedText: string
): {
  text: string;
  start: number;
  end: number;
  selectionFound: boolean;
  selectionIndex: number;
} {
  const selectionIndex = report.indexOf(selectedText);
  if (selectionIndex === -1) {
    return {
      text: report,
      start: 0,
      end: report.length,
      selectionFound: false,
      selectionIndex: -1,
    };
  }

  const headingPattern = /^---$|^## /m;
  const lines = report.split("\n");
  let charOffset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(charOffset);
    charOffset += line.length + 1;
  }

  let sectionStartLine = 0;
  let sectionEndLine = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const offset = lineOffsets[i];
    if (offset > selectionIndex) break;
    if (headingPattern.test(lines[i])) {
      sectionStartLine = i;
    }
  }

  for (let i = sectionStartLine + 1; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      const offset = lineOffsets[i];
      if (offset > selectionIndex + selectedText.length) {
        sectionEndLine = i;
        break;
      }
      sectionStartLine = i;
    }
  }

  const start = lineOffsets[sectionStartLine];
  const end =
    sectionEndLine < lines.length
      ? lineOffsets[sectionEndLine]
      : report.length;

  return {
    text: report.slice(start, end),
    start,
    end,
    selectionFound: true,
    selectionIndex,
  };
}

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
    const accumulatedState: Record<string, unknown> = {};

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

    const mergeIntoAccumulatedState = (output: Record<string, unknown>) => {
      if (output.sceneSummaries && Array.isArray(output.sceneSummaries)) {
        const existing = (accumulatedState.sceneSummaries as Array<Record<string, unknown>>) ?? [];
        const incoming = output.sceneSummaries as Array<Record<string, unknown>>;
        const byId = new Map<number, Record<string, unknown>>();
        for (const s of existing) byId.set(s.sceneId as number, s);
        for (const s of incoming) byId.set(s.sceneId as number, s);
        const { sceneSummaries: _ss, ...rest } = output;
        Object.assign(accumulatedState, rest);
        accumulatedState.sceneSummaries = Array.from(byId.values()).sort(
          (a, b) => (a.sceneId as number) - (b.sceneId as number)
        );
      } else {
        Object.assign(accumulatedState, output);
      }
    };

    const handleUpdateChunk = (update: Record<string, unknown>) => {
      for (const [nodeName, nodeOutput] of Object.entries(update)) {
        const output = nodeOutput as Record<string, unknown>;
        mergeIntoAccumulatedState(output);
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
            const retryCount =
              typeof output.retryCount === "number" ? output.retryCount : 0;
            const parsedIssues = parseValidationIssues(report?.issues);
            const validationSummary = summarizeValidationIssues(parsedIssues);
            log("Étape terminée: validator", {
              jobId: job.id,
              isValid: report?.isValid,
              retryCount,
              ...validationSummary,
            });

            publishProcessJobEvent(job, "step:complete", {
              step: "validator",
              label: report?.isValid
                ? "Validation OK"
                : `Validation: ${report?.issues?.length || 0} problème(s) détecté(s)`,
              data: { validationReport: report, retryCount },
            });

            const errorSceneIds = validationSummary.errorSceneIds;

            if (
              report &&
              !report.isValid &&
              retryCount < 2 &&
              errorSceneIds.length > 0
            ) {
              const retryScenes = narrativeScenesCache.filter((s) =>
                errorSceneIds.includes(s.id)
              );
              log("Phase corrective déclenchée", {
                jobId: job.id,
                correctionAttempt: retryCount,
                maxRetries: 2,
                retryScenesCount: retryScenes.length,
                retrySceneIds: retryScenes.map((s) => s.id),
                retrySceneTitles: retryScenes.map((s) => s.title),
                validationSceneBreakdown: validationSummary.sceneBreakdown,
              });

              publishProcessJobEvent(job, "step:start", {
                step: "summarizer",
                label: `Correction parallèle des ${retryScenes.length} scène(s) en erreur (tentative ${retryCount})...`,
                data: {
                  totalScenes: retryScenes.length,
                  retryCount,
                  retrySceneIds: retryScenes.map((s) => s.id),
                },
              });
              sendSceneCollection("summarizer", retryScenes);
            } else {
              if (report && !report.isValid && retryCount >= 2) {
                log("Phase corrective arrêtée: limite de tentatives atteinte", {
                  jobId: job.id,
                  retryCount,
                  maxRetries: 2,
                  remainingErrorSceneIds: errorSceneIds,
                });
              } else if (report && !report.isValid && errorSceneIds.length === 0) {
                log(
                  "Phase corrective non déclenchée: aucune scène en erreur ciblable",
                  {
                    jobId: job.id,
                    retryCount,
                    issuesCount: validationSummary.issuesCount,
                  }
                );
              } else {
                log("Validation finale: passage au formatter", {
                  jobId: job.id,
                  retryCount,
                  isValid: report?.isValid,
                });
              }
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

            // Build the workflow state to persist (exclude heavy/transient fields)
            const { messages, rawTranscript: _rt, preprocessedTranscript: _pt, currentStep: _cs, finalReport: _fr, ...nodeOutputs } = accumulatedState as Record<string, unknown>;
            const persistableState = {
              ...nodeOutputs,
              playerInfo: job.playerInfo,
              universeName: job.universeName,
            };

            const reportId = randomUUID();
            try {
              insertReport({
                id: reportId,
                jobId: job.id,
                reportMd: finalReport,
                universeName: job.universeName,
                transcriptName: job.transcriptName,
                players: job.playerInfo,
                workflowState: persistableState,
                rawTranscript: job.input.rawTranscript,
                preprocessedTranscript: accumulatedState.preprocessedTranscript as string ?? null,
                universeContext: job.input.universeContext || null,
                sessionHistory: job.input.sessionHistory || null,
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
              scenes: accumulatedState.scenes,
              entities: accumulatedState.entities,
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
  // Don't send heavy fields in the detail response
  const { workflowState, rawTranscript, preprocessedTranscript, universeContext, sessionHistory, ...rest } = report;
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
    const model = createModel("correction", 0.15);

    const currentReport = report.reportMd;
    const previousReport = currentReport;

    const section = extractSectionContaining(currentReport, selectedText);

    // ── Build transcript & analysis context from stored data ──
    const ws = report.workflowState ?? {};
    const scenes = (ws.scenes as SceneMeta[]) ?? [];
    const speakerMap = (ws.speakerMap as Record<string, string>) ?? {};
    const entities = ws.entities as { pcs?: unknown[]; npcs?: unknown[]; locations?: string[]; items?: string[] } | undefined;
    const characterProfiles = (ws.characterProfiles as Array<{ characterName: string; playerName: string; knownAbilities?: string[]; roleInGroup?: string }>) ?? [];

    let transcriptContext = "";
    let matchedSceneTitle = "";

    if (report.preprocessedTranscript && scenes.length > 0) {
      // Find which scene(s) the section corresponds to by matching ## headings
      const sectionHeadingMatch = section.text.match(/^## (.+)$/m);
      const matchedScene = sectionHeadingMatch
        ? scenes.find((s) => s.title === sectionHeadingMatch[1])
        : null;

      if (matchedScene) {
        matchedSceneTitle = matchedScene.title;
        transcriptContext = extractSceneText(
          report.preprocessedTranscript,
          matchedScene.startLine,
          matchedScene.endLine
        );
      }
    }

    const contextParts: string[] = [];

    if (Object.keys(speakerMap).length > 0) {
      const mapLines = Object.entries(speakerMap)
        .map(([speaker, name]) => `- ${speaker} → ${name}`)
        .join("\n");
      contextParts.push(`## Correspondance Speakers\n${mapLines}`);
    }

    if (characterProfiles.length > 0) {
      const profileLines = characterProfiles
        .map((p) => {
          let line = `- **${p.characterName}** (${p.playerName})`;
          if (p.roleInGroup) line += ` — ${p.roleInGroup}`;
          if (p.knownAbilities?.length) line += ` | Capacités: ${p.knownAbilities.join(", ")}`;
          return line;
        })
        .join("\n");
      contextParts.push(`## Personnages-Joueurs\n${profileLines}`);
    }

    if (entities?.npcs && Array.isArray(entities.npcs) && entities.npcs.length > 0) {
      const npcLines = entities.npcs
        .map((n: any) => {
          let line = `- **${n.name}**`;
          if (n.role) line += ` — ${n.role}`;
          return line;
        })
        .join("\n");
      contextParts.push(`## PNJs connus\n${npcLines}`);
    }

    if (report.sessionHistory) {
      contextParts.push(`## Historique des sessions précédentes\n${report.sessionHistory}`);
    }

    const globalContext = contextParts.length > 0
      ? `\n\n# Contexte de référence\n\n${contextParts.join("\n\n")}`
      : "";

    const transcriptBlock = transcriptContext
      ? `\n\n## Transcript original de la scène "${matchedSceneTitle}"\n\nVoici les lignes exactes du transcript correspondant à cette section. Utilise-les comme source de vérité pour valider les faits, attributions de paroles et actions.\n\n\`\`\`\n${transcriptContext}\n\`\`\``
      : "";

    log("Correction ciblée: demande reçue", {
      reportId,
      selectedTextLength: selectedText.length,
      instructionLength: instruction.length,
      selectedTextPreview: toSingleLinePreview(selectedText),
      instructionPreview: toSingleLinePreview(instruction),
      selectionFoundInReport: section.selectionFound,
      sectionLength: section.text.length,
      hasTranscriptContext: !!transcriptContext,
      matchedScene: matchedSceneTitle || null,
      transcriptContextLines: transcriptContext ? transcriptContext.split("\n").length : 0,
      hasGlobalContext: contextParts.length > 0,
    });

    const correctionResponse = await model.invoke([
      new SystemMessage(
        `Tu es un expert en édition de comptes-rendus de JDR au format Markdown.\n\n` +
        `## Ta mission\n` +
        `On te donne UNE SECTION d'un compte-rendu et une demande de correction ciblée.\n` +
        `Tu dois retourner UNIQUEMENT la section corrigée.\n\n` +
        `## Règles\n` +
        `- Retourne UNIQUEMENT la section modifiée (pas le rapport complet)\n` +
        `- Ne modifie QUE ce qui est demandé par l'instruction\n` +
        `- Conserve le même style, la même structure, le même formatage Markdown\n` +
        `- Si la correction concerne l'attribution d'une action (qui a fait quoi), vérifie dans le transcript original qui parle/agit réellement\n` +
        `- Le transcript original fait foi : les tags [SPEAKER_XX] identifient les locuteurs, utilise la correspondance speakers pour les nommer\n` +
        `- Ne supprime jamais de contenu sauf si explicitement demandé\n` +
        `- Ne rajoute pas de contenu non demandé\n` +
        `- La sortie doit pouvoir remplacer directement la section dans le document original\n` +
        globalContext
      ),
      new HumanMessage(
        `## Section à modifier\n\n${section.text}\n\n` +
        transcriptBlock +
        `\n\n## Passage sélectionné par l'utilisateur\n\n"${selectedText}"\n\n` +
        `## Correction demandée\n\n${instruction}\n\n` +
        `Retourne UNIQUEMENT la section corrigée. Rien d'autre.`
      ),
    ]);

    const correctedSection =
      typeof correctionResponse.content === "string"
        ? correctionResponse.content
        : JSON.stringify(correctionResponse.content);
    const sectionChanged = correctedSection.trim() !== section.text.trim();
    log("Correction ciblée: réponse modèle reçue", {
      reportId,
      correctedSectionLength: correctedSection.length,
      sectionDeltaLength: correctedSection.length - section.text.length,
      sectionChanged,
      correctedSectionPreview: toSingleLinePreview(correctedSection, 220),
    });

    const correctedReport = currentReport.slice(0, section.start) +
      correctedSection +
      currentReport.slice(section.end);

    const correctionId = randomUUID();
    insertCorrection({
      id: correctionId,
      reportId,
      selectedText,
      instruction,
      previousReportMd: previousReport,
    });
    updateReportMd(reportId, correctedReport);

    log("Correction applied (targeted)", {
      reportId,
      correctionId,
      instructionPreview: toSingleLinePreview(instruction),
      selectedTextPreview: toSingleLinePreview(selectedText),
      sectionLength: section.text.length,
      correctedSectionLength: correctedSection.length,
      reportChanged: correctedReport !== currentReport,
      fullReportLength: currentReport.length,
    });

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

// ── Scene editing ────────────────────────────────────────────────────────────

app.get("/api/reports/:id/scenes", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }

  const workflowState = report.workflowState as Record<string, unknown>;
  const scenes = (workflowState?.scenes as SceneMeta[]) || [];
  const sceneSummaries = (workflowState?.sceneSummaries as Array<{ sceneId: number }>) || [];

  const summaryById = new Map(sceneSummaries.map((s) => [s.sceneId, s]));
  const preprocessedTranscript = report.preprocessedTranscript || "";

  res.json({
    scenes: scenes.map((scene) => {
      const isMetaScene = scene.type === "meta" || scene.type === "pause";
      const transcriptExcerpt = isMetaScene && preprocessedTranscript
        ? extractSceneText(preprocessedTranscript, scene.startLine, scene.endLine)
        : null;

      return {
        ...scene,
        analystSummary: scene.summary ?? null,
        transcriptExcerpt,
        summary: summaryById.get(scene.id) || null,
      };
    }),
  });
});

const SceneMetadataSchema = z.object({
  diceRolls: z
    .array(
      z.object({
        character: z.string().describe("Personnage qui lance le dé"),
        skill: z.string().describe("Compétence ou sphère utilisée"),
        result: z.string().describe("Résultat du jet (succès/échec/détails)"),
        context: z.string().describe("Contexte de l'action"),
      })
    )
    .describe("Jets de dés mentionnés dans le récit"),
  npcsInvolved: z
    .array(z.string())
    .describe("PNJs mentionnés ou impliqués dans cette scène"),
  technicalNotes: z
    .array(z.string())
    .optional()
    .describe("Notes techniques, règles, points d'attention"),
  keyEvents: z
    .array(z.string())
    .describe("Événements clés de la scène"),
});

app.put("/api/reports/:id/scenes/:sceneId", async (req, res) => {
  const reportId = req.params.id;
  const sceneId = Number.parseInt(req.params.sceneId, 10);

  if (!Number.isFinite(sceneId)) {
    res.status(400).json({ message: "ID de scène invalide." });
    return;
  }

  const report = getReport(reportId);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }

  const narrativeSummary = typeof req.body?.narrativeSummary === "string"
    ? req.body.narrativeSummary.trim()
    : "";

  if (!narrativeSummary) {
    res.status(400).json({ message: "Le contenu narratif est requis." });
    return;
  }

  try {
    const workflowState = report.workflowState as Record<string, unknown>;
    const sceneSummaries = (workflowState?.sceneSummaries as Array<Record<string, unknown>>) || [];
    const scenes = (workflowState?.scenes as SceneMeta[]) || [];
    const speakerMap = (workflowState?.speakerMap as Record<string, string>) ?? {};

    const sceneIndex = sceneSummaries.findIndex(
      (s) => s.sceneId === sceneId
    );

    if (sceneIndex === -1) {
      res.status(404).json({ message: "Scène introuvable." });
      return;
    }

    const scene = scenes.find((s) => s.id === sceneId);

    // Re-extract metadata from the updated narrative via LLM
    let extractedMetadata: z.infer<typeof SceneMetadataSchema> | null = null;
    try {
      const model = createModel("correction", 0.1);
      const structuredModel = model.withStructuredOutput(SceneMetadataSchema);

      let transcriptHint = "";
      if (report.preprocessedTranscript && scene) {
        const sceneTranscript = extractSceneText(
          report.preprocessedTranscript,
          scene.startLine,
          scene.endLine
        );
        if (sceneTranscript) {
          transcriptHint = `\n\n## Transcript original de la scène (pour référence)\n\`\`\`\n${sceneTranscript}\n\`\`\``;
        }
      }

      const speakerHint = Object.keys(speakerMap).length > 0
        ? `\n\nCorrespondance speakers : ${Object.entries(speakerMap).map(([k, v]) => `${k} → ${v}`).join(", ")}`
        : "";

      extractedMetadata = await structuredModel.invoke([
        new SystemMessage(
          `Tu es un assistant d'analyse de comptes-rendus de JDR.\n` +
          `Extrais les métadonnées structurées du récit narratif fourni.\n` +
          `- diceRolls : uniquement les jets de dés explicitement mentionnés dans le récit\n` +
          `- npcsInvolved : les PNJs (pas les PJs) mentionnés dans le récit\n` +
          `- technicalNotes : observations techniques ou mécaniques pertinentes\n` +
          `- keyEvents : événements clés dans l'ordre chronologique` +
          speakerHint
        ),
        new HumanMessage(
          `## Récit narratif de la scène\n\n${narrativeSummary}` +
          transcriptHint
        ),
      ]);

      log("Scene metadata re-extracted", {
        reportId,
        sceneId,
        diceRollsCount: extractedMetadata.diceRolls.length,
        npcsCount: extractedMetadata.npcsInvolved.length,
        keyEventsCount: extractedMetadata.keyEvents.length,
      });
    } catch (metaErr) {
      log("Scene metadata extraction failed, keeping existing metadata", {
        reportId,
        sceneId,
        error: metaErr instanceof Error ? metaErr.message : String(metaErr),
      });
    }

    const updatedSummary: Record<string, unknown> = {
      ...sceneSummaries[sceneIndex],
      narrativeSummary,
    };

    if (extractedMetadata) {
      updatedSummary.diceRolls = extractedMetadata.diceRolls;
      updatedSummary.npcsInvolved = extractedMetadata.npcsInvolved;
      updatedSummary.technicalNotes = extractedMetadata.technicalNotes ?? [];
      updatedSummary.keyEvents = extractedMetadata.keyEvents;
    }

    sceneSummaries[sceneIndex] = updatedSummary;

    const updatedWorkflowState = {
      ...workflowState,
      sceneSummaries,
    };

    updateReportWorkflowState(reportId, updatedWorkflowState);

    // Regenerate the report using the formatter
    const { formatterNode } = await import("./agents/formatter.js");
    const formatterResult = await formatterNode(updatedWorkflowState as any);
    const newReport = formatterResult.finalReport as string;

    updateReportMd(reportId, newReport);

    log("Scene updated and report regenerated", { reportId, sceneId });

    res.json({
      reportId,
      sceneId,
      reportMd: newReport,
      updatedSummary,
    });
  } catch (err) {
    log("Scene update error", {
      reportId,
      sceneId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      message: err instanceof Error ? err.message : "Erreur lors de la mise à jour de la scène.",
    });
  }
});

// ── Report rebuild (re-format from existing summaries, no LLM call) ─────────

app.post("/api/reports/:id/rebuild", async (req, res) => {
  const reportId = req.params.id;
  const report = getReport(reportId);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }

  try {
    const workflowState = report.workflowState as Record<string, unknown>;
    const scenes = (workflowState?.scenes as SceneMeta[]) || [];
    const sceneSummaries = (workflowState?.sceneSummaries as Array<Record<string, unknown>>) || [];

    log("Rebuild report: démarrage", {
      reportId,
      scenesCount: scenes.length,
      summariesCount: sceneSummaries.length,
    });

    const { formatterNode } = await import("./agents/formatter.js");
    const formatterResult = await formatterNode(workflowState as any);
    const newReport = formatterResult.finalReport as string;

    updateReportMd(reportId, newReport);

    log("Rebuild report: terminé", { reportId, reportLength: newReport.length });

    res.json({ reportId, reportMd: newReport });
  } catch (err) {
    log("Rebuild report: erreur", {
      reportId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      message: err instanceof Error ? err.message : "Erreur lors de la reconstruction du rapport.",
    });
  }
});

// ── Scene regeneration ───────────────────────────────────────────────────────

app.post("/api/reports/:id/scenes/:sceneId/regenerate", async (req, res) => {
  const reportId = req.params.id;
  const sceneId = Number.parseInt(req.params.sceneId, 10);

  if (!Number.isFinite(sceneId)) {
    res.status(400).json({ message: "ID de scène invalide." });
    return;
  }

  const report = getReport(reportId);
  if (!report) {
    res.status(404).json({ message: "Rapport introuvable." });
    return;
  }

  if (!report.preprocessedTranscript) {
    res.status(400).json({ message: "Transcript préprocessé non disponible pour ce rapport." });
    return;
  }

  try {
    const workflowState = report.workflowState as Record<string, unknown>;
    const scenes = (workflowState?.scenes as SceneMeta[]) || [];
    const sceneSummaries = (workflowState?.sceneSummaries as Array<Record<string, unknown>>) || [];

    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) {
      res.status(404).json({ message: "Scène introuvable dans le workflow." });
      return;
    }

    const userInstruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
    log("Régénération scène: demande", { reportId, sceneId, title: scene.title, hasInstruction: !!userInstruction });

    const { summarizeSingleScene } = await import("./agents/summarizer.js");

    const newSummary = await summarizeSingleScene(sceneId, {
      scenes: scenes as any,
      preprocessedTranscript: report.preprocessedTranscript,
      universeContext: report.universeContext || "",
      speakerMap: (workflowState?.speakerMap as Record<string, string>) ?? {},
      entities: (workflowState?.entities as any) ?? { pcs: [], npcs: [], locations: [], items: [] },
      characterProfiles: (workflowState?.characterProfiles as any[]) ?? [],
      playerInfo: report.players as any,
    }, userInstruction || undefined);

    const existingIndex = sceneSummaries.findIndex((s) => s.sceneId === sceneId);
    if (existingIndex >= 0) {
      sceneSummaries[existingIndex] = newSummary as unknown as Record<string, unknown>;
    } else {
      sceneSummaries.push(newSummary as unknown as Record<string, unknown>);
      sceneSummaries.sort((a, b) => (a.sceneId as number) - (b.sceneId as number));
    }

    const updatedWorkflowState = { ...workflowState, sceneSummaries };
    updateReportWorkflowState(reportId, updatedWorkflowState);

    const { formatterNode } = await import("./agents/formatter.js");
    const formatterResult = await formatterNode(updatedWorkflowState as any);
    const newReport = formatterResult.finalReport as string;

    updateReportMd(reportId, newReport);

    log("Régénération scène: terminée", { reportId, sceneId });

    res.json({
      reportId,
      sceneId,
      reportMd: newReport,
      regeneratedSummary: newSummary,
    });
  } catch (err) {
    log("Régénération scène: erreur", {
      reportId,
      sceneId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      message: err instanceof Error ? err.message : "Erreur lors de la régénération de la scène.",
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

if (!isProduction) {
  app.get("/", (_req, res) => {
    res.redirect(frontendDevUrl);
  });
}

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
