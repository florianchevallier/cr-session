import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { WorkflowStateType } from "../graph/state.js";
import { FORMATTER_SYSTEM_PROMPT } from "../config/prompts.js";
import { createModel } from "../config/llm.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

// ── Formatter node ───────────────────────────────────────────────────────────

export async function formatterNode(
  state: WorkflowStateType
): Promise<Partial<WorkflowStateType>> {
  log("Début nœud: formatter", {
    scenesCount: state.sceneSummaries.length,
  });
  const model = createModel("pro", 0.25);

  const playerInfoStr = state.playerInfo
    .map((p) => `| ${p.playerName} | ${p.characterName} |`)
    .join("\n");

  const systemPrompt = FORMATTER_SYSTEM_PROMPT.replace(
    "{universeName}",
    state.universeName || "Générique"
  ).replace("{playerInfo}", playerInfoStr);

  // Build the content for the formatter
  const orderedSummaries = [...state.sceneSummaries].sort(
    (a, b) => a.sceneId - b.sceneId
  );

  const scenesContent = orderedSummaries
    .map((s) => {
      const scene = state.scenes.find((sc) => sc.id === s.sceneId);
      const narrativeWordCount = s.narrativeSummary
        .split(/\s+/)
        .filter(Boolean).length;
      return (
        `## SCENE_ID: ${s.sceneId}\n` +
        `TITLE: ${scene?.title || "Sans titre"}\n` +
        `TYPE: ${scene?.type || "?"}\n` +
        `LOCATION: ${scene?.location || "?"}\n` +
        `NARRATIVE_WORD_COUNT: ${narrativeWordCount}\n` +
        `NARRATIVE:\n${s.narrativeSummary}\n` +
        `KEY_EVENTS:\n${s.keyEvents.map((e) => `- ${e}`).join("\n")}\n` +
        `DICE_ROLLS:\n${s.diceRolls.map((d) => `- ${d.character} — ${d.skill} : ${d.result} (${d.context})`).join("\n")}\n` +
        `NPCS: ${s.npcsInvolved.join(", ")}\n` +
        `TECH_NOTES:\n${(s.technicalNotes || []).map((n) => `- ${n}`).join("\n")}`
      );
    })
    .join("\n\n===\n\n");

  const entitiesStr = JSON.stringify(state.entities, null, 2);

  // Validation warnings to include
  const warnings = state.validationReport.issues
    .filter((i) => i.severity === "warning" || i.severity === "info")
    .map((i) => `- [${i.severity}] ${i.issue}`)
    .join("\n");

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `## Données à formater\n\n` +
        `### Scènes\n\n${scenesContent}\n\n` +
        `### Entités complètes\n\n${entitiesStr}\n\n` +
        (warnings
          ? `### Notes du validateur\n\n${warnings}\n\n`
          : "") +
        `## Contraintes impératives\n` +
        `- Respecte l'ordre strict des SCENE_ID (chronologie de session).\n` +
        `- Pour chaque scène, crée une section "Timeline détaillée" en reprenant les KEY_EVENTS dans le même ordre.\n` +
        `- Conserve le bloc NARRATIVE de façon fidèle et détaillée : ne le compresse pas, n'en retire pas les nuances.\n` +
        `- N'invente aucun événement, aucun dialogue, aucun PNJ.\n\n` +
        `Génère maintenant le compte-rendu Markdown final complet.`
    ),
  ]);

  const finalReport =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  log("Fin nœud: formatter", { reportLength: finalReport.length });

  return {
    finalReport,
    currentStep: "formatter_complete",
  };
}
