import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

// ── Zod schemas for structured data ──────────────────────────────────────────

export const PlayerInfoSchema = z.object({
  playerName: z.string().describe("Nom du joueur (ex: Emilie)"),
  characterName: z.string().describe("Nom du personnage-joueur (ex: Yumi)"),
  speakerHint: z
    .string()
    .optional()
    .describe("Indice de speaker dans le transcript (ex: SPEAKER_00)"),
});

export const SceneSchema = z.object({
  id: z.number().describe("ID séquentiel de la scène"),
  title: z.string().describe("Titre évocateur de la scène"),
  startLine: z.number().describe("Numéro de ligne de début"),
  endLine: z.number().describe("Numéro de ligne de fin"),
  type: z
    .enum(["narrative", "combat", "social", "exploration", "meta", "pause"])
    .describe("Type de scène"),
  location: z.string().optional().describe("Lieu de la scène"),
  summary: z
    .string()
    .optional()
    .describe("Résumé court pour le contexte inter-scènes"),
});

export const EntitySchema = z.object({
  pcs: z.array(
    z.object({
      name: z.string(),
      player: z.string(),
      description: z.string().optional(),
    })
  ),
  npcs: z.array(
    z.object({
      name: z.string(),
      role: z.string().optional(),
      description: z.string().optional(),
    })
  ),
  locations: z.array(z.string()),
  items: z.array(z.string()),
});

export const SceneSummarySchema = z.object({
  sceneId: z.number(),
  narrativeSummary: z
    .string()
    .describe("Récit narratif immersif de la scène"),
  keyEvents: z.array(z.string()).describe("Événements clés"),
  diceRolls: z
    .array(
      z.object({
        character: z.string(),
        skill: z.string(),
        result: z.string(),
        context: z.string(),
      })
    )
    .describe("Jets de dés importants"),
  npcsInvolved: z.array(z.string()).describe("PNJs impliqués"),
  technicalNotes: z.array(z.string()).optional().describe("Notes techniques"),
});

export const ValidationIssueSchema = z.object({
  sceneId: z.number().optional(),
  issue: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  suggestion: z.string().optional(),
});

export const ValidationReportSchema = z.object({
  isValid: z.boolean(),
  issues: z.array(ValidationIssueSchema),
});

// ── LangGraph State Annotation ───────────────────────────────────────────────

export const WorkflowState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // ── Input config ──
  rawTranscript: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  preprocessedTranscript: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  universeContext: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  sessionHistory: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  universeName: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "generic",
  }),
  playerInfo: Annotation<z.infer<typeof PlayerInfoSchema>[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // ── Analyst output ──
  scenes: Annotation<z.infer<typeof SceneSchema>[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  speakerMap: Annotation<Record<string, string>>({
    reducer: (_, b) => b,
    default: () => ({}),
  }),
  entities: Annotation<z.infer<typeof EntitySchema>>({
    reducer: (_, b) => b,
    default: () => ({ pcs: [], npcs: [], locations: [], items: [] }),
  }),

  // ── Summarizer: file d'attente et progression (une scène par invocation) ──
  pendingSceneIds: Annotation<number[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  currentSceneIndex: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  lastProcessedScene: Annotation<{
    id: number;
    title: string;
    startLine: number;
    endLine: number;
  } | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  nextScene: Annotation<{
    id: number;
    title: string;
    startLine: number;
    endLine: number;
  } | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // ── Summarizer output ──
  sceneSummaries: Annotation<z.infer<typeof SceneSummarySchema>[]>({
    reducer: (a, b) => {
      const byId = new Map<number, z.infer<typeof SceneSummarySchema>>();
      for (const s of a ?? []) byId.set(s.sceneId, s);
      for (const s of b ?? []) byId.set(s.sceneId, s);
      return Array.from(byId.values()).sort((x, y) => x.sceneId - y.sceneId);
    },
    default: () => [],
  }),

  // ── Validator output ──
  validationReport: Annotation<z.infer<typeof ValidationReportSchema>>({
    reducer: (_, b) => b,
    default: () => ({ isValid: true, issues: [] }),
  }),
  retryCount: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),

  // ── Formatter output ──
  finalReport: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),

  // ── Progress tracking ──
  currentStep: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "idle",
  }),
});

export type WorkflowStateType = typeof WorkflowState.State;
