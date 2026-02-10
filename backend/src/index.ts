import express from "express";
import cors from "cors";
import multer from "multer";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { buildWorkflow } from "./graph/workflow.js";

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
  const path = getDraftPath(safe);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const o = data as Record<string, unknown>;
    const defaultPlayers: PlayerDraft[] = [];
    if (Array.isArray(o.defaultPlayers)) {
      for (const item of o.defaultPlayers) {
        const p = parsePlayerDraft(item);
        if (p) defaultPlayers.push(p);
      }
    }
    return {
      universeContext: typeof o.universeContext === "string" ? o.universeContext : "",
      sessionHistory: typeof o.sessionHistory === "string" ? o.sessionHistory : "",
      defaultPlayers: defaultPlayers.length > 0 ? defaultPlayers : undefined,
    };
  } catch {
    return null;
  }
}

function writeEditorDraft(universeId: string, draft: EditorDraft): void {
  const safe = safeUniverseId(universeId);
  if (!safe) return;
  try {
    mkdirSync(editorDraftsDir, { recursive: true });
  } catch {
    // ignore
  }
  const path = getDraftPath(safe);
  writeFileSync(path, JSON.stringify(draft, null, 2), "utf-8");
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

// ── Process transcript (SSE streaming) ───────────────────────────────────────

app.post("/api/process", upload.single("transcript"), async (req, res) => {
  log("POST /api/process reçu");

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (type: string, data: unknown) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Parse input
    const transcriptText = req.file
      ? req.file.buffer.toString("utf-8")
      : req.body.transcript;

    if (!transcriptText) {
      log("Erreur: aucun transcript fourni");
      sendEvent("error", { message: "Aucun transcript fourni." });
      res.end();
      return;
    }

    const {
      universeContext = "",
      sessionHistory = "",
      universeName = "generic",
      playerInfo = "[]",
    } = req.body;

    const players = typeof playerInfo === "string" ? JSON.parse(playerInfo) : playerInfo;

    log("Démarrage workflow", {
      transcriptLength: transcriptText.length,
      lines: transcriptText.split("\n").length,
      universe: universeName,
      playersCount: Array.isArray(players) ? players.length : 0,
    });

    sendEvent("step:start", { step: "preprocessor", label: "Preprocessing du transcript..." });

    // Build and run the workflow with streaming
    const workflow = buildWorkflow();

    const input = {
      rawTranscript: transcriptText,
      universeContext,
      sessionHistory,
      universeName,
      playerInfo: players,
    };

    // Stream the workflow execution: updates + custom events (scene-level progress)
    const stream = await workflow.stream(input, {
      streamMode: ["updates", "custom"],
    });

    let narrativeScenesCache: SceneMeta[] = [];

    const sendSceneCollection = (
      group: "summarizer" | "validator",
      scenes: SceneMeta[]
    ) => {
      sendEvent("step:scenes", {
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
        sendEvent(custom.event, custom.payload);
      }
    };

    const handleUpdateChunk = (update: Record<string, unknown>) => {
      for (const [nodeName, nodeOutput] of Object.entries(update)) {
        const output = nodeOutput as Record<string, unknown>;
        switch (nodeName) {
          case "preprocessor":
            log("Étape terminée: preprocessor");
            sendEvent("step:complete", {
              step: "preprocessor",
              label: "Preprocessing terminé",
            });
            sendEvent("step:start", {
              step: "analyst",
              label: "Analyse du transcript (détection scènes, speakers, entités)...",
            });
            break;

          case "analyst": {
            const scenes =
              (output.scenes as SceneMeta[]) || [];
            const narrativeScenes = scenes.filter(
              (s) => s.type !== "meta" && s.type !== "pause"
            );
            narrativeScenesCache = narrativeScenes;
            log("Étape terminée: analyst", {
              scenesCount: scenes.length,
              narrativeScenesCount: narrativeScenes.length,
            });

            sendEvent("step:complete", {
              step: "analyst",
              label: "Analyse terminée",
              data: {
                scenesCount: scenes.length,
                narrativeScenesCount: narrativeScenes.length,
                speakerMap: output.speakerMap,
                entitiesPreview: output.entities,
              },
            });
            sendEvent("step:start", {
              step: "summarizer",
              label:
                "Analyse détaillée des scènes (en parallèle, subset transcript par agent)",
              data: { totalScenes: narrativeScenes.length },
            });
            sendSceneCollection("summarizer", narrativeScenes);
            break;
          }

          case "summarizer": {
            const summariesCount =
              (output.sceneSummaries as unknown[])?.length ?? 0;
            log("Étape terminée: summarizer", { summariesCount });
            sendEvent("step:complete", {
              step: "summarizer",
              label: `Analyse terminée (${summariesCount} scène(s) traitée(s))`,
              data: { summariesCount },
            });

            sendEvent("step:start", {
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
              isValid: report?.isValid,
              issuesCount: report?.issues?.length ?? 0,
              retryCount,
            });

            sendEvent("step:complete", {
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

              sendEvent("step:start", {
                step: "summarizer",
                label: `Correction parallèle des ${retryScenes.length} scène(s) en erreur (tentative ${retryCount + 1})...`,
                data: { totalScenes: retryScenes.length, retryCount },
              });
              sendSceneCollection("summarizer", retryScenes);
            } else {
              sendEvent("step:start", {
                step: "formatter",
                label: "Mise en forme du compte-rendu...",
              });
            }
            break;
          }

          case "formatter": {
            const finalReport = output.finalReport as string;
            log("Étape terminée: formatter", {
              reportLength: typeof finalReport === "string" ? finalReport.length : 0,
            });
            sendEvent("step:complete", {
              step: "formatter",
              label: "Compte-rendu généré !",
            });
            sendEvent("result", {
              finalReport: output.finalReport,
              scenes: output.scenes,
              entities: output.entities,
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

    // Send the final state
    log("Workflow terminé avec succès");
    sendEvent("done", { message: "Traitement terminé." });
  } catch (error) {
    log("Workflow en erreur", {
      message: error instanceof Error ? error.message : String(error),
    });
    console.error("Workflow error:", error);
    sendEvent("error", {
      message:
        error instanceof Error ? error.message : "Erreur interne du serveur",
      stack:
        process.env.NODE_ENV === "development" && error instanceof Error
          ? error.stack
          : undefined,
    });
  } finally {
    res.end();
  }
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
