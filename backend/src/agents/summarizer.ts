import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import { z } from "zod";
import {
  WorkflowStateType,
  SceneSummarySchema,
  SceneSchema,
  EntitySchema,
  CharacterProfileSchema,
  PlayerInfoSchema,
} from "../graph/state.js";
import { SUMMARIZER_SYSTEM_PROMPT } from "../config/prompts.js";
import { createModel } from "../config/llm.js";
import { extractSceneText } from "../tools/preprocessing.js";
import {
  buildCharacterIdentities,
  buildIdentityGuardrailsText,
  buildAbilityGuardrailsText,
} from "../tools/identity-guardrails.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

// ── Types ────────────────────────────────────────────────────────────────────

type Scene = z.infer<typeof SceneSchema>;
type SceneSummary = z.infer<typeof SceneSummarySchema>;
type StreamWriter = ((chunk: unknown) => void) | undefined;
type ValidationIssue = WorkflowStateType["validationReport"]["issues"][number];

const SCENE_CONCURRENCY = 5;
const ISSUE_PREVIEW_LIMIT = 3;
const ISSUE_MESSAGE_MAX_LENGTH = 140;
const CORRECTION_WANTED_LIMIT = 6;

function truncateForLog(value: string, maxLength = ISSUE_MESSAGE_MAX_LENGTH): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function summarizeIssueSeverities(issues: ValidationIssue[]): {
  errorsCount: number;
  warningsCount: number;
  infosCount: number;
} {
  return {
    errorsCount: issues.filter((i) => i.severity === "error").length,
    warningsCount: issues.filter((i) => i.severity === "warning").length,
    infosCount: issues.filter((i) => i.severity === "info").length,
  };
}

function buildIssuePreview(issues: ValidationIssue[]): string[] {
  return issues.slice(0, ISSUE_PREVIEW_LIMIT).map((issue) => {
    const suggestion = issue.suggestion
      ? ` -> ${truncateForLog(issue.suggestion, 90)}`
      : "";
    return `[${issue.severity}] ${truncateForLog(issue.issue)}${suggestion}`;
  });
}

function buildCorrectionWanted(issues: ValidationIssue[]): string[] {
  return issues.slice(0, CORRECTION_WANTED_LIMIT).map((issue) => {
    const suggestion = issue.suggestion
      ? truncateForLog(issue.suggestion, 120)
      : "Aucune suggestion fournie";
    return `[${issue.severity}] ${truncateForLog(issue.issue)} => ${suggestion}`;
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function getNarrativeTargets(lineCount: number): {
  minWords: number;
  minParagraphs: number;
  maxParagraphs: number;
} {
  if (lineCount <= 35) {
    return { minWords: 120, minParagraphs: 2, maxParagraphs: 3 };
  }
  if (lineCount <= 90) {
    return { minWords: 220, minParagraphs: 3, maxParagraphs: 5 };
  }
  return { minWords: 350, minParagraphs: 5, maxParagraphs: 8 };
}

function emitSceneStepStart(writer: StreamWriter, scene: Scene, kind: "analyse" | "correction"): void {
  writer?.({
    event: "step:start",
    payload: {
      step: `summarizer_scene_${scene.id}`,
      label: `Scène ${scene.id} : ${scene.title} (L${scene.startLine}-${scene.endLine})`,
      data: {
        sceneId: scene.id,
        title: scene.title,
        startLine: scene.startLine,
        endLine: scene.endLine,
        mode: kind,
      },
    },
  });
}

function emitSceneStepComplete(writer: StreamWriter, scene: Scene): void {
  writer?.({
    event: "step:complete",
    payload: {
      step: `summarizer_scene_${scene.id}`,
      label: `Scène ${scene.id} : ${scene.title} — analysée`,
      data: {
        sceneId: scene.id,
        title: scene.title,
        startLine: scene.startLine,
        endLine: scene.endLine,
      },
    },
  });
}

// ── Helper: build per-scene human message ────────────────────────────────────

function buildScenePrompt(
  scene: Scene,
  sceneText: string,
  allScenes: Scene[],
  state: WorkflowStateType
): string {
  const totalScenes = allScenes.filter(
    (s) => s.type !== "meta" && s.type !== "pause"
  ).length;

  const sceneIndex = allScenes.findIndex((s) => s.id === scene.id);
  const prevScene = sceneIndex > 0 ? allScenes[sceneIndex - 1] : null;
  const nextScene =
    sceneIndex < allScenes.length - 1 ? allScenes[sceneIndex + 1] : null;

  const continuityContext = [
    prevScene
      ? `- **Scène précédente** : "${prevScene.title}" (${prevScene.type}) — ${prevScene.summary || "pas de résumé"}`
      : "- **Scène précédente** : Aucune (c'est le début de la session)",
    nextScene
      ? `- **Scène suivante** : "${nextScene.title}" (${nextScene.type}) — ${nextScene.summary || "pas de résumé"}`
      : "- **Scène suivante** : Aucune (c'est la fin de la session)",
  ].join("\n");

  let retryContext = "";
  if (state.retryCount > 0) {
    const sceneIssues = state.validationReport.issues.filter(
      (i) => i.sceneId === scene.id
    );
    retryContext =
      `\n### ⚠️ CORRECTION DEMANDÉE\nCette scène est en cours de correction. Problèmes signalés par le validateur :\n` +
      sceneIssues
        .map(
          (i) =>
            `- **${i.severity}** : ${i.issue} → Suggestion : ${i.suggestion}`
        )
        .join("\n") +
      `\n\nCorrige ces problèmes dans ta nouvelle version.`;

    const hasCrossSceneIssue = sceneIssues.some((i) =>
      i.issue.includes("[Inter-scènes]")
    );
    if (hasCrossSceneIssue) {
      const otherSummaries = state.sceneSummaries.filter(
        (s) => s.sceneId !== scene.id
      );
      if (otherSummaries.length > 0) {
        retryContext +=
          `\n\n### Résumés des autres scènes (pour cohérence inter-scènes)\n` +
          `Utilise ces résumés pour t'assurer que ta version corrigée est COHÉRENTE avec les faits établis dans les autres scènes.\n\n` +
          otherSummaries
            .map((s) => {
              const sc = allScenes.find((x) => x.id === s.sceneId);
              return `**Scène ${s.sceneId}${sc ? ` — ${sc.title}` : ""}** :\n${s.narrativeSummary.slice(0, 500)}${s.narrativeSummary.length > 500 ? "..." : ""}`;
            })
            .join("\n\n");
      }
    }
  }

  const lineCount = sceneText.split("\n").length;
  const narrativeTargets = getNarrativeTargets(lineCount);
  const identityGuardrails = buildIdentityGuardrailsText(
    buildCharacterIdentities(state),
    state.characterProfiles
  );

  return (
    `# 🎯 Ta mission : analyser la Scène ${scene.id} sur ${totalScenes}\n\n` +
    `## Métadonnées de la scène\n` +
    `- **Titre** : ${scene.title}\n` +
    `- **Type** : ${scene.type}\n` +
    `- **Lieu** : ${scene.location || "Non défini"}\n` +
    `- **Lignes** : ${scene.startLine} à ${scene.endLine} (${lineCount} lignes de transcript)\n\n` +
    `## Contexte narratif (continuité)\n` +
    `${continuityContext}\n` +
    `\n${identityGuardrails}\n` +
    `${retryContext}\n\n` +
    `## 📜 Transcript COMPLET de la scène (à analyser ligne par ligne)\n\n` +
    `Ci-dessous le transcript intégral de cette scène. Analyse CHAQUE ligne attentivement.\n` +
    `Ne saute aucun dialogue, aucune action, aucun jet de dé.\n\n` +
    `\`\`\`\n${sceneText}\n\`\`\`\n\n` +
    `## Rappel\n` +
    `- Ton narrativeSummary doit être COMPLET et DÉTAILLÉ (${lineCount} lignes de transcript → récit proportionnellement long)\n` +
    `- Objectif de densité : au moins ${narrativeTargets.minWords} mots, répartis en ${narrativeTargets.minParagraphs} à ${narrativeTargets.maxParagraphs} paragraphes\n` +
    `- Respecte une chronologie STRICTE : raconte uniquement dans l'ordre L${scene.startLine} → L${scene.endLine}, sans anticipation ni retour en arrière\n` +
    `- Structure conseillée du récit : mise en place -> développement -> tension/pivot -> retombée/transition\n` +
    `- Vérifie l'agent de chaque action : qui parle, qui décide, qui exécute\n` +
    `- N'attribue pas une action à un personnage si le transcript ne l'établit pas clairement\n` +
    `- En cas d'ambiguïté, signale-la dans technicalNotes au lieu d'inventer une attribution\n` +
    `- Ne crée JAMAIS de nom hybride en mélangeant deux personnages\n` +
    `- Liste TOUS les événements dans keyEvents\n` +
    `- Chaque entrée de keyEvents doit commencer par [Lx] ou [Lx-Ly]\n` +
    `- keyEvents doit aussi être strictement chronologique (du premier au dernier événement)\n` +
    `- Capture TOUS les jets de dés (lignes 🎲) dans l'ordre d'apparition\n` +
    `- Mentionne TOUS les PNJs impliqués\n` +
    `- Utilise les VRAIS noms (pas SPEAKER_XX) en te référant à la carte des speakers`
  );
}

// ── Summarizer node : scènes en parallèle, sous-agent par scène ─────────────

export async function summarizerNode(
  state: WorkflowStateType
): Promise<Partial<WorkflowStateType>> {
  const model = createModel("summarizer", 0.2);
  const writer = getWriter();
  const isCorrectionPass = state.retryCount > 0;
  const phase = isCorrectionPass ? "correction" : "analyse";

  const pendingSceneIds =
    state.pendingSceneIds.length > 0
      ? state.pendingSceneIds
      : state.scenes
          .filter((s) => s.type !== "meta" && s.type !== "pause")
          .map((s) => s.id);

  const scenesToProcess = pendingSceneIds
    .map((id) => state.scenes.find((s) => s.id === id))
    .filter(
      (scene): scene is Scene =>
        !!scene && scene.type !== "meta" && scene.type !== "pause"
    );

  const issuesBySceneId = new Map<number, ValidationIssue[]>();
  if (isCorrectionPass) {
    for (const issue of state.validationReport.issues) {
      if (typeof issue.sceneId !== "number") continue;
      const sceneIssues = issuesBySceneId.get(issue.sceneId) ?? [];
      sceneIssues.push(issue);
      issuesBySceneId.set(issue.sceneId, sceneIssues);
    }
  }

  if (scenesToProcess.length === 0) {
    log("Début nœud: summarizer — aucune scène à traiter, skip", {
      phase,
      retryCount: state.retryCount,
      pendingSceneIds,
    });
    return {
      pendingSceneIds,
      currentStep: "summarizer_complete",
      lastProcessedScene: null,
      nextScene: null,
    };
  }

  log("Début nœud: summarizer", {
    phase,
    scenesCount: scenesToProcess.length,
    retryCount: state.retryCount,
    batchSize: SCENE_CONCURRENCY,
    pendingSceneIds,
  });

  if (isCorrectionPass) {
    const correctionContext = scenesToProcess.map((scene) => {
      const sceneIssues = issuesBySceneId.get(scene.id) ?? [];
      return {
        sceneId: scene.id,
        title: scene.title,
        issuesCount: sceneIssues.length,
        ...summarizeIssueSeverities(sceneIssues),
        issuePreview: buildIssuePreview(sceneIssues),
        correctionWanted: buildCorrectionWanted(sceneIssues),
        omittedCorrectionsCount: Math.max(
          0,
          sceneIssues.length - CORRECTION_WANTED_LIMIT
        ),
      };
    });

    log("Contexte correction: summarizer", {
      retryCount: state.retryCount,
      scenesWithIssues: correctionContext.filter((c) => c.issuesCount > 0).length,
      scenesWithoutIssues: correctionContext.filter((c) => c.issuesCount === 0)
        .length,
      byScene: correctionContext,
    });
  }

  const speakerMapStr = Object.entries(state.speakerMap)
    .map(([k, v]) => `${k} → ${v}`)
    .join("\n");
  const entitiesStr = JSON.stringify(state.entities, null, 2);
  const scenesOverview = state.scenes
    .map(
      (s) =>
        `- Scène ${s.id}: "${s.title}" [${s.type}] — ${s.location || "?"} (L${s.startLine}-L${s.endLine})${s.summary ? ` — ${s.summary}` : ""}`
    )
    .join("\n");

  const characterProfilesStr =
    state.characterProfiles.length > 0
      ? buildAbilityGuardrailsText(state.characterProfiles)
      : "Aucun profil de personnage disponible. Sois très prudent sur les attributions.";

  const systemPrompt = SUMMARIZER_SYSTEM_PROMPT.replace(
    "{universeContext}",
    state.universeContext || "Non spécifié."
  )
    .replace("{speakerMap}", speakerMapStr)
    .replace("{characterProfiles}", characterProfilesStr)
    .replace("{entities}", entitiesStr)
    .replace("{scenesOverview}", scenesOverview);

  const structuredModel = model.withStructuredOutput(SceneSummarySchema);

  const summaries: SceneSummary[] = [];
  const sceneBatches = chunkArray(scenesToProcess, SCENE_CONCURRENCY);

  for (let bi = 0; bi < sceneBatches.length; bi++) {
    const batch = sceneBatches[bi];
    log("Summarizer batch", {
      phase,
      retryCount: state.retryCount,
      batchIndex: bi + 1,
      totalBatches: sceneBatches.length,
      sceneIds: batch.map((s) => s.id),
    });
    const batchResults = await Promise.all(
      batch.map(async (scene) => {
        const sceneIssues = issuesBySceneId.get(scene.id) ?? [];
        if (isCorrectionPass) {
          log("Correction scène: démarrage summarizer", {
            sceneId: scene.id,
            title: scene.title,
            retryCount: state.retryCount,
            issuesCount: sceneIssues.length,
            ...summarizeIssueSeverities(sceneIssues),
            issuePreview: buildIssuePreview(sceneIssues),
            correctionWanted: buildCorrectionWanted(sceneIssues),
            omittedCorrectionsCount: Math.max(
              0,
              sceneIssues.length - CORRECTION_WANTED_LIMIT
            ),
          });
        }

        emitSceneStepStart(
          writer,
          scene,
          isCorrectionPass ? "correction" : "analyse"
        );

        const sceneText = extractSceneText(
          state.preprocessedTranscript,
          scene.startLine,
          scene.endLine
        );
        const scenePrompt = buildScenePrompt(
          scene,
          sceneText,
          state.scenes,
          state
        );

        const MAX_INVOKE_RETRIES = 3;
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_INVOKE_RETRIES; attempt++) {
          try {
            log("Summarizer invoke", {
              phase,
              sceneId: scene.id,
              retryCount: state.retryCount,
              attempt,
              maxAttempts: MAX_INVOKE_RETRIES,
            });
            const result = await structuredModel.invoke([
              new SystemMessage(systemPrompt),
              new HumanMessage(scenePrompt),
            ]);
            const narrativeWords = result.narrativeSummary
              .split(/\s+/)
              .filter(Boolean).length;
            log("Summarizer scène terminée", {
              phase,
              sceneId: scene.id,
              retryCount: state.retryCount,
              attempt,
              narrativeWords,
              keyEventsCount: result.keyEvents.length,
              diceRollsCount: result.diceRolls.length,
              npcsCount: result.npcsInvolved.length,
              technicalNotesCount: result.technicalNotes?.length ?? 0,
            });
            emitSceneStepComplete(writer, scene);
            return { ...result, sceneId: scene.id };
          } catch (err) {
            lastError = err;
            log(`Summarizer invoke error scene ${scene.id}`, {
              phase,
              retryCount: state.retryCount,
              attempt,
              maxAttempts: MAX_INVOKE_RETRIES,
              error: err instanceof Error ? err.message : String(err),
            });
            if (attempt < MAX_INVOKE_RETRIES) {
              const delay = 2000 * attempt;
              log("Summarizer retry scheduled", {
                phase,
                sceneId: scene.id,
                retryCount: state.retryCount,
                nextAttempt: attempt + 1,
                delayMs: delay,
              });
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }
        throw lastError;
      })
    );

    summaries.push(...batchResults);
  }

  log("Fin nœud: summarizer", {
    phase,
    retryCount: state.retryCount,
    summariesCount: summaries.length,
    processedSceneIds: summaries.map((s) => s.sceneId),
  });

  return {
    sceneSummaries: summaries,
    pendingSceneIds,
    currentStep: "summarizer_complete",
    lastProcessedScene: null,
    nextScene: null,
  };
}

// ── Standalone single-scene regeneration (used by the API) ──────────────────

export interface RegenerationInput {
  scenes: z.infer<typeof SceneSchema>[];
  preprocessedTranscript: string;
  universeContext: string;
  speakerMap: Record<string, string>;
  entities: z.infer<typeof EntitySchema>;
  characterProfiles: z.infer<typeof CharacterProfileSchema>[];
  playerInfo: z.infer<typeof PlayerInfoSchema>[];
}

export async function summarizeSingleScene(
  sceneId: number,
  input: RegenerationInput,
  userInstruction?: string
): Promise<z.infer<typeof SceneSummarySchema>> {
  const scene = input.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);

  const model = createModel("summarizer", 0.2);
  const structuredModel = model.withStructuredOutput(SceneSummarySchema);

  const sceneText = extractSceneText(
    input.preprocessedTranscript,
    scene.startLine,
    scene.endLine
  );

  const minimalState = {
    retryCount: 0,
    validationReport: { isValid: true, issues: [] },
    characterProfiles: input.characterProfiles,
    playerInfo: input.playerInfo,
    speakerMap: input.speakerMap,
    entities: input.entities,
    scenes: input.scenes,
    sceneSummaries: [],
    preprocessedTranscript: input.preprocessedTranscript,
    universeContext: input.universeContext,
    rawTranscript: "",
    sessionHistory: "",
    universeName: "",
    messages: [],
    pendingSceneIds: [],
    currentSceneIndex: 0,
    lastProcessedScene: null,
    nextScene: null,
    finalReport: "",
    currentStep: "",
  } as unknown as WorkflowStateType;

  const scenePrompt = buildScenePrompt(scene, sceneText, input.scenes, minimalState);

  const speakerMapStr = Object.entries(input.speakerMap)
    .map(([k, v]) => `${k} → ${v}`)
    .join("\n");
  const entitiesStr = JSON.stringify(input.entities, null, 2);
  const scenesOverview = input.scenes
    .map(
      (s) =>
        `- Scène ${s.id}: "${s.title}" [${s.type}] — ${s.location || "?"} (L${s.startLine}-L${s.endLine})${s.summary ? ` — ${s.summary}` : ""}`
    )
    .join("\n");

  const characterProfilesStr =
    input.characterProfiles.length > 0
      ? buildAbilityGuardrailsText(input.characterProfiles)
      : "Aucun profil de personnage disponible.";

  const systemPrompt = SUMMARIZER_SYSTEM_PROMPT.replace(
    "{universeContext}",
    input.universeContext || "Non spécifié."
  )
    .replace("{speakerMap}", speakerMapStr)
    .replace("{characterProfiles}", characterProfilesStr)
    .replace("{entities}", entitiesStr)
    .replace("{scenesOverview}", scenesOverview);

  log("Régénération scène: démarrage", { sceneId, title: scene.title, hasUserInstruction: !!userInstruction });

  let finalScenePrompt = scenePrompt;
  if (userInstruction) {
    finalScenePrompt +=
      `\n\n## ⚠️ INSTRUCTION DE L'UTILISATEUR (PRIORITÉ HAUTE)\n` +
      `L'utilisateur demande spécifiquement les changements suivants pour cette scène :\n\n` +
      `> ${userInstruction}\n\n` +
      `Prends en compte cette demande dans ta régénération, tout en respectant les règles du système ` +
      `(fidélité au transcript, zéro méta-game, attributions correctes, etc.).`;
  }

  const MAX_INVOKE_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_INVOKE_RETRIES; attempt++) {
    try {
      const result = await structuredModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(finalScenePrompt),
      ]);
      log("Régénération scène: terminée", {
        sceneId,
        attempt,
        narrativeWords: result.narrativeSummary.split(/\s+/).filter(Boolean).length,
      });
      return { ...result, sceneId: scene.id };
    } catch (err) {
      lastError = err;
      log("Régénération scène: erreur", {
        sceneId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < MAX_INVOKE_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastError;
}
