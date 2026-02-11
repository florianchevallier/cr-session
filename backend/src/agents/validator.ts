import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getWriter } from "@langchain/langgraph";
import { z } from "zod";
import {
  WorkflowStateType,
  ValidationReportSchema,
} from "../graph/state.js";
import { VALIDATOR_SYSTEM_PROMPT } from "../config/prompts.js";
import { createModel } from "../config/llm.js";
import { extractSceneText } from "../tools/preprocessing.js";
import {
  buildCharacterIdentities,
  findPotentiallyMergedNames,
} from "../tools/identity-guardrails.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

const MAX_RETRIES = 2;
const VALIDATION_CONCURRENCY = 5;

const PerSceneIssueSchema = z.object({
  issue: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  suggestion: z.string().optional(),
});

const PerSceneValidationSchema = z.object({
  isValid: z.boolean(),
  issues: z.array(PerSceneIssueSchema),
});

function parseKeyEventLineRange(
  keyEvent: string
): { start: number; end: number } | null {
  const match = keyEvent.match(/^\s*\[L(\d+)(?:-L?(\d+))?\]/i);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2] ?? match[1], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || end <= 0 || end < start) return null;
  return { start, end };
}

function truncateForIssue(value: string, maxLength = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── Validator node ───────────────────────────────────────────────────────────

export async function validatorNode(
  state: WorkflowStateType
): Promise<Partial<WorkflowStateType>> {
  const scenesToValidate = state.sceneSummaries.length;
  log("Début nœud: validator", {
    scenesCount: scenesToValidate,
    batchSize: VALIDATION_CONCURRENCY,
    retryCount: state.retryCount,
    pendingSceneIds: state.pendingSceneIds,
  });
  const model = createModel("flash", 0.1);
  const writer = getWriter();

  const entitiesStr = JSON.stringify(state.entities, null, 2);
  const speakerMapStr = Object.entries(state.speakerMap)
    .map(([speaker, identity]) => `${speaker} -> ${identity}`)
    .join("\n");
  const characterIdentities = buildCharacterIdentities(state);

  const systemPrompt = VALIDATOR_SYSTEM_PROMPT.replace(
    "{universeContext}",
    state.universeContext || "Non spécifié."
  )
    .replace("{entities}", entitiesStr)
    .replace(
      "{speakerMap}",
      speakerMapStr || "Aucune carte des speakers disponible."
    );

  const structuredModel = model.withStructuredOutput(PerSceneValidationSchema);

  // On retry, only validate scenes that were re-summarized (pendingSceneIds)
  const sceneIdsToValidate =
    state.retryCount > 0 && state.pendingSceneIds.length > 0
      ? new Set(state.pendingSceneIds)
      : null;

  const scenesWithSummaries = state.sceneSummaries
    .map((summary) => ({
      summary,
      scene: state.scenes.find((s) => s.id === summary.sceneId),
    }))
    .filter(
      (entry): entry is {
        summary: (typeof state.sceneSummaries)[number];
        scene: (typeof state.scenes)[number];
      } => !!entry.scene
    )
    .filter((entry) => entry.scene.type !== "meta" && entry.scene.type !== "pause")
    .filter((entry) => !sceneIdsToValidate || sceneIdsToValidate.has(entry.scene.id));

  // Carry forward issues from scenes not being re-validated
  const aggregatedIssues: z.infer<typeof ValidationReportSchema>["issues"] =
    sceneIdsToValidate
      ? state.validationReport.issues.filter(
          (i) => i.sceneId != null && !sceneIdsToValidate.has(i.sceneId)
        )
      : [];

  const batches = chunkArray(scenesWithSummaries, VALIDATION_CONCURRENCY);
  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async ({ scene, summary }) => {
        writer?.({
          event: "step:start",
          payload: {
            step: `validator_scene_${scene.id}`,
            label: `Validation scène ${scene.id} : ${scene.title} (L${scene.startLine}-${scene.endLine})`,
            data: {
              sceneId: scene.id,
              title: scene.title,
              startLine: scene.startLine,
              endLine: scene.endLine,
            },
          },
        });

        const sceneText = extractSceneText(
          state.preprocessedTranscript,
          scene.startLine,
          scene.endLine
        );

        const perSceneValidation = await structuredModel.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(
            `Valide cette scène précisément. Tu as le contexte global, mais tu dois juger la fidélité du résumé par rapport au transcript de CETTE scène.\n\n` +
              `## Scène ${scene.id}: ${scene.title}\n` +
              `Type: ${scene.type} | Lieu: ${scene.location || "?"}\n` +
              `Lignes: ${scene.startLine}-${scene.endLine}\n\n` +
              `## Transcript source exact (subset)\n` +
              `\`\`\`\n${sceneText}\n\`\`\`\n\n` +
              `## Résumé produit pour cette scène\n` +
              `Narrative:\n${summary.narrativeSummary}\n\n` +
              `Key events:\n${summary.keyEvents.map((e) => `- ${e}`).join("\n")}\n\n` +
              `Dice rolls:\n${summary.diceRolls.map((d) => `- ${d.character} | ${d.skill} | ${d.result} | ${d.context}`).join("\n")}\n\n` +
              `NPCs:\n${summary.npcsInvolved.map((n) => `- ${n}`).join("\n")}\n\n` +
              `Technical notes:\n${(summary.technicalNotes || []).map((n) => `- ${n}`).join("\n")}\n\n` +
              `## Ce que tu dois vérifier\n` +
              `1. Fidélité stricte au transcript (pas d'invention)\n` +
              `2. Omissions majeures (événements, dialogues clés, jets de dés)\n` +
              `3. Cohérence des noms/personnages/PNJs\n` +
              `4. Cohérence mécanique (jets, conséquences)\n` +
              `5. Clarté et complétude narrative\n` +
              `6. Chronologie stricte: le résumé suit l'ordre réel des événements dans cette scène\n` +
              `7. ⚠️ ATTRIBUTION DES ACTIONS (CRITIQUE): Pour CHAQUE action majeure mentionnée dans le résumé:\n` +
              `   - Identifie dans le transcript source QUEL speaker/personnage réalise cette action\n` +
              `   - Vérifie que le résumé attribue l'action au BON personnage\n` +
              `   - Si l'attribution est incorrecte, c'est une "error"\n` +
              `   - Vérifie aussi: qui parle, qui décide, qui agit, qui subit, qui lance les dés\n` +
              `   - Les jets de dés doivent être attribués au personnage qui lance, pas à la cible\n` +
              `8. Interdiction de fusion d'identité (ex: combinaison de 2 personnages dans un nom hybride)\n` +
              `9. Traçabilité: les keyEvents pointent vers des lignes plausibles [Lx] ou [Lx-Ly]\n\n` +
              `Retourne uniquement le JSON structuré demandé.`
          ),
        ]);

        const summaryTextForChecks = [
          summary.narrativeSummary,
          ...summary.keyEvents,
        ].join("\n");
        const mergedNameFindings = findPotentiallyMergedNames(
          summaryTextForChecks,
          characterIdentities
        );
        const ruleBasedIssues = mergedNameFindings.map((finding) => ({
          issue: `Fusion potentielle de personnages detectee: "${finding.mergedName}"`,
          severity: "error" as const,
          suggestion: `Corriger l'attribution en separant clairement "${finding.leftCanonical}" et "${finding.rightCanonical}".`,
        }));
        const keyEventLineIssues = summary.keyEvents.flatMap((event) => {
          const range = parseKeyEventLineRange(event);
          if (!range) {
            return [
              {
                issue: `Key event sans repere source [Lx] ou [Lx-Ly]: "${truncateForIssue(
                  event
                )}"`,
                severity: "error" as const,
                suggestion:
                  "Ajoute un repere de lignes au debut de chaque key event.",
              },
            ];
          }
          if (range.start < scene.startLine || range.end > scene.endLine) {
            return [
              {
                issue: `Repere de lignes hors scene pour key event: [L${range.start}-L${range.end}]`,
                severity: "error" as const,
                suggestion: `Utilise des lignes comprises entre L${scene.startLine} et L${scene.endLine}.`,
              },
            ];
          }
          return [];
        });
        const sceneIssues = [...perSceneValidation.issues, ...ruleBasedIssues];
        sceneIssues.push(...keyEventLineIssues);

        writer?.({
          event: "step:complete",
          payload: {
            step: `validator_scene_${scene.id}`,
            label: `Validation scène ${scene.id} : ${scene.title} — ${sceneIssues.length} issue(s)`,
            data: {
              sceneId: scene.id,
              title: scene.title,
              startLine: scene.startLine,
              endLine: scene.endLine,
              issuesCount: sceneIssues.length,
            },
          },
        });

        return {
          sceneId: scene.id,
          issues: sceneIssues.map((issue) => ({
            ...issue,
            sceneId: scene.id,
          })),
        };
      })
    );

    for (const result of batchResults) {
      aggregatedIssues.push(...result.issues);
    }
  }

  const hasErrors = aggregatedIssues.some((i) => i.severity === "error");
  log("Fin nœud: validator", {
    isValid: !hasErrors,
    issuesCount: aggregatedIssues.length,
    errorsCount: aggregatedIssues.filter((i) => i.severity === "error").length,
    retryCount: state.retryCount + 1,
  });
  const pendingSceneIds = hasErrors
    ? [
        ...new Set(
          aggregatedIssues
            .filter((i) => i.severity === "error" && i.sceneId != null)
            .map((i) => i.sceneId!)
        ),
      ]
    : [];

  return {
    validationReport: {
      isValid: !hasErrors,
      issues: aggregatedIssues,
    },
    retryCount: state.retryCount + 1,
    ...(pendingSceneIds.length > 0 && state.retryCount + 1 < MAX_RETRIES
      ? {
          pendingSceneIds,
          currentSceneIndex: 0,
        }
      : {}),
    currentStep: "validator_complete",
  };
}
