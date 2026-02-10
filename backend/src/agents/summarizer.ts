import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import { z } from "zod";
import {
  WorkflowStateType,
  SceneSummarySchema,
  SceneSchema,
} from "../graph/state.js";
import { SUMMARIZER_SYSTEM_PROMPT } from "../config/prompts.js";
import { createModel } from "../config/llm.js";
import { extractSceneText } from "../tools/preprocessing.js";
import {
  buildCharacterIdentities,
  buildIdentityGuardrailsText,
} from "../tools/identity-guardrails.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

// ── Types ────────────────────────────────────────────────────────────────────

type Scene = z.infer<typeof SceneSchema>;
type SceneSummary = z.infer<typeof SceneSummarySchema>;
type StreamWriter = ((chunk: unknown) => void) | undefined;

const SCENE_CONCURRENCY = 5;

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

  const retryContext =
    state.retryCount > 0
      ? `\n### ⚠️ CORRECTION DEMANDÉE\nCette scène est en cours de correction. Problèmes signalés par le validateur :\n${state.validationReport.issues
          .filter((i) => i.sceneId === scene.id)
          .map((i) => `- **${i.severity}** : ${i.issue} → Suggestion : ${i.suggestion}`)
          .join("\n")}\n\nCorrige ces problèmes dans ta nouvelle version.`
      : "";

  const lineCount = sceneText.split("\n").length;
  const narrativeTargets = getNarrativeTargets(lineCount);
  const identityGuardrails = buildIdentityGuardrailsText(
    buildCharacterIdentities(state)
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
  const model = createModel("pro", 0.2);
  const writer = getWriter();

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

  if (scenesToProcess.length === 0) {
    log("Début nœud: summarizer — aucune scène à traiter, skip");
    return {
      pendingSceneIds,
      currentStep: "summarizer_complete",
      lastProcessedScene: null,
      nextScene: null,
    };
  }

  log("Début nœud: summarizer", {
    scenesCount: scenesToProcess.length,
    retryCount: state.retryCount,
    batchSize: SCENE_CONCURRENCY,
  });

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

  const systemPrompt = SUMMARIZER_SYSTEM_PROMPT.replace(
    "{universeContext}",
    state.universeContext || "Non spécifié."
  )
    .replace("{speakerMap}", speakerMapStr)
    .replace("{entities}", entitiesStr)
    .replace("{scenesOverview}", scenesOverview);

  const structuredModel = model.withStructuredOutput(SceneSummarySchema);

  const summaries: SceneSummary[] = [];
  const sceneBatches = chunkArray(scenesToProcess, SCENE_CONCURRENCY);

  for (let bi = 0; bi < sceneBatches.length; bi++) {
    const batch = sceneBatches[bi];
    log("Summarizer batch", {
      batchIndex: bi + 1,
      totalBatches: sceneBatches.length,
      sceneIds: batch.map((s) => s.id),
    });
    const batchResults = await Promise.all(
      batch.map(async (scene) => {
        emitSceneStepStart(
          writer,
          scene,
          state.retryCount > 0 ? "correction" : "analyse"
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

        const result = await structuredModel.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(scenePrompt),
        ]);

        emitSceneStepComplete(writer, scene);

        return { ...result, sceneId: scene.id };
      })
    );

    summaries.push(...batchResults);
  }

  log("Fin nœud: summarizer", { summariesCount: summaries.length });

  return {
    sceneSummaries: summaries,
    pendingSceneIds,
    currentStep: "summarizer_complete",
    lastProcessedScene: null,
    nextScene: null,
  };
}
