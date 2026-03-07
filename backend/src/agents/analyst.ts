import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  WorkflowStateType,
  SceneSchema,
  EntitySchema,
  CharacterProfileSchema,
} from "../graph/state.js";
import { ANALYST_SYSTEM_PROMPT } from "../config/prompts.js";
import { createModel } from "../config/llm.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

// ── Structured output schema for the analyst ─────────────────────────────────

const SpeakerEntrySchema = z.object({
  speakerId: z.string().describe("Ex: SPEAKER_00"),
  identification: z.string().describe("Ex: Laurent (MJ) ou Emilie (Yumi)"),
});

const AnalystOutputSchema = z.object({
  speakerMap: z
    .array(SpeakerEntrySchema)
    .describe(
      "Liste des associations SPEAKER_XX -> identification (MJ, joueur + personnage)"
    ),
  entities: EntitySchema,
  scenes: z.array(SceneSchema),
  characterProfiles: z
    .array(CharacterProfileSchema)
    .describe(
      "Profils détaillés de chaque PJ avec compétences, limitations, patterns de parole et rôle"
    ),
});

// ── Analyst node ─────────────────────────────────────────────────────────────

export async function analystNode(
  state: WorkflowStateType
): Promise<Partial<WorkflowStateType>> {
  log("Début nœud: analyst", {
    transcriptLines: state.preprocessedTranscript.split("\n").length,
  });
  const model = createModel("analyst", 0.2);

  const playerInfoStr = state.playerInfo.length
    ? state.playerInfo
        .map((p) => {
          let line = `- ${p.playerName} joue ${p.characterName}`;
          if (p.speakerHint) line += ` (probablement ${p.speakerHint})`;
          if (p.characterDetails) line += `\n  Détails : ${p.characterDetails}`;
          return line;
        })
        .join("\n")
    : "Aucune information sur les joueurs fournie. Déduis-les du transcript.";

  const systemPrompt = ANALYST_SYSTEM_PROMPT.replace(
    "{universeContext}",
    state.universeContext || "Aucun contexte d'univers spécifié."
  )
    .replace("{playerInfo}", playerInfoStr)
    .replace(
      "{sessionHistory}",
      state.sessionHistory || "Aucun historique de session précédente."
    );

  const structuredModel = model.withStructuredOutput(AnalystOutputSchema);

  const result = await structuredModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Analyse ce transcript de session JDR et extrais-en la structure.\n\n` +
        `## Statistiques du preprocessing\n` +
        `Le transcript contient environ ${state.preprocessedTranscript.split("\n").length} lignes.\n\n` +
        `## Transcript complet\n\n${state.preprocessedTranscript}`
    ),
  ]);

  const speakerMapRecord: Record<string, string> = Object.fromEntries(
    result.speakerMap.map((s) => [s.speakerId, s.identification])
  );

  const pendingSceneIds = result.scenes
    .filter((s) => s.type !== "meta" && s.type !== "pause")
    .map((s) => s.id);

  log("Fin nœud: analyst", {
    scenesCount: result.scenes.length,
    narrativeScenesCount: pendingSceneIds.length,
    speakersCount: result.speakerMap.length,
    characterProfilesCount: result.characterProfiles.length,
  });

  return {
    speakerMap: speakerMapRecord,
    entities: result.entities,
    scenes: result.scenes,
    characterProfiles: result.characterProfiles,
    pendingSceneIds,
    currentSceneIndex: 0,
    currentStep: "analyst_complete",
  };
}
