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
  buildAbilityGuardrailsText,
  findPotentiallyMergedNames,
  findGMAsCharacterIssues,
} from "../tools/identity-guardrails.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

const MAX_RETRIES = 2;
const VALIDATION_CONCURRENCY = 5;
const ISSUE_PREVIEW_LIMIT = 3;
const ISSUE_SUGGESTION_PREVIEW_MAX_LENGTH = 90;
const VALIDATOR_INVOKE_MAX_ATTEMPTS = 3;
const VALIDATOR_RETRY_BASE_DELAY_MS = 2000;

const PerSceneIssueSchema = z.object({
  issue: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  suggestion: z.string().optional(),
});

const PerSceneValidationSchema = z.object({
  isValid: z.boolean(),
  issues: z.array(PerSceneIssueSchema),
});

const GMCoherenceIssueSchema = z.object({
  sceneId: z.number().describe("ID de la scène contenant le problème"),
  passage: z.string().describe("Le passage exact du résumé où le MJ est traité comme un personnage"),
  issue: z.string().describe("Description du problème"),
  likelyRealCharacter: z
    .string()
    .describe("Le PJ ou PNJ qui devrait probablement être mentionné à la place du MJ"),
});

const GMCoherenceCheckSchema = z.object({
  issues: z.array(GMCoherenceIssueSchema),
});

const CrossSceneIssueSchema = z.object({
  sceneIdToFix: z
    .number()
    .describe(
      "ID de la scène la plus probablement fautive (généralement la plus tardive)"
    ),
  contradictedBySceneId: z
    .number()
    .describe("ID de la scène qui établit le fait contredit"),
  issue: z.string(),
  severity: z.enum(["error", "warning"]),
  suggestion: z.string().optional(),
});

const CrossSceneValidationSchema = z.object({
  issues: z.array(CrossSceneIssueSchema),
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeIssueSeverities(
  issues: Array<{ severity: "error" | "warning" | "info"; issue: string }>
): {
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

function buildIssuePreview(
  issues: Array<{ severity: "error" | "warning" | "info"; issue: string; suggestion?: string }>
): string[] {
  return issues.slice(0, ISSUE_PREVIEW_LIMIT).map((issue) => {
    const suggestion = issue.suggestion
      ? ` -> ${truncateForIssue(issue.suggestion, ISSUE_SUGGESTION_PREVIEW_MAX_LENGTH)}`
      : "";
    return `[${issue.severity}] ${truncateForIssue(issue.issue)}${suggestion}`;
  });
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
  const phase = state.retryCount > 0 ? "correction" : "analyse";
  log("Début nœud: validator", {
    phase,
    scenesCount: scenesToValidate,
    batchSize: VALIDATION_CONCURRENCY,
    retryCount: state.retryCount,
    pendingSceneIds: state.pendingSceneIds,
  });
  const model = createModel("validator", 0.1);
  const writer = getWriter();

  const entitiesStr = JSON.stringify(state.entities, null, 2);
  const speakerMapStr = Object.entries(state.speakerMap)
    .map(([speaker, identity]) => `${speaker} -> ${identity}`)
    .join("\n");
  const characterIdentities = buildCharacterIdentities(state);

  const characterProfilesStr =
    state.characterProfiles?.length > 0
      ? buildAbilityGuardrailsText(state.characterProfiles)
      : "Aucun profil de personnage disponible.";

  const systemPrompt = VALIDATOR_SYSTEM_PROMPT.replace(
    "{universeContext}",
    state.universeContext || "Non spécifié."
  )
    .replace("{entities}", entitiesStr)
    .replace(
      "{speakerMap}",
      speakerMapStr || "Aucune carte des speakers disponible."
    )
    .replace("{characterProfiles}", characterProfilesStr);

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

  if (sceneIdsToValidate) {
    log("Validator en mode correction", {
      retryCount: state.retryCount,
      sceneIdsToRevalidate: [...sceneIdsToValidate],
      scenesSelectedForValidation: scenesWithSummaries.map((s) => s.scene.id),
      carriedForwardIssuesCount: aggregatedIssues.length,
    });
  }

  log("Validator sélection scènes", {
    phase,
    scenesSelectedCount: scenesWithSummaries.length,
    sceneIds: scenesWithSummaries.map((entry) => entry.scene.id),
  });

  const batches = chunkArray(scenesWithSummaries, VALIDATION_CONCURRENCY);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    log("Validator batch", {
      phase,
      retryCount: state.retryCount,
      batchIndex: bi + 1,
      totalBatches: batches.length,
      sceneIds: batch.map((entry) => entry.scene.id),
    });
    const batchResults = await Promise.all(
      batch.map(async ({ scene, summary }) => {
        log("Validator scène: démarrage", {
          phase,
          retryCount: state.retryCount,
          sceneId: scene.id,
          title: scene.title,
          startLine: scene.startLine,
          endLine: scene.endLine,
        });
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

        const perScenePrompt =
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
          `9. Traçabilité: les keyEvents pointent vers des lignes plausibles [Lx] ou [Lx-Ly]\n` +
          `10. Limite-toi à 12 issues maximum, en priorisant error > warning > info\n\n` +
          `Retourne uniquement le JSON structuré demandé.`;

        const llmIssues: z.infer<typeof PerSceneIssueSchema>[] = [];
        let llmInvokeFailed = false;
        let lastInvokeError: unknown;

        for (let attempt = 1; attempt <= VALIDATOR_INVOKE_MAX_ATTEMPTS; attempt++) {
          try {
            log("Validator scène: invoke", {
              phase,
              retryCount: state.retryCount,
              sceneId: scene.id,
              attempt,
              maxAttempts: VALIDATOR_INVOKE_MAX_ATTEMPTS,
            });
            const perSceneValidation = await structuredModel.invoke([
              new SystemMessage(systemPrompt),
              new HumanMessage(perScenePrompt),
            ]);
            llmIssues.push(...perSceneValidation.issues);
            log("Validator scène: invoke réussi", {
              phase,
              retryCount: state.retryCount,
              sceneId: scene.id,
              attempt,
              llmIssuesCount: perSceneValidation.issues.length,
            });
            lastInvokeError = undefined;
            break;
          } catch (error) {
            lastInvokeError = error;
            log("Validator scène: invoke error", {
              phase,
              retryCount: state.retryCount,
              sceneId: scene.id,
              attempt,
              maxAttempts: VALIDATOR_INVOKE_MAX_ATTEMPTS,
              error: getErrorMessage(error),
            });
            if (attempt < VALIDATOR_INVOKE_MAX_ATTEMPTS) {
              const delayMs = VALIDATOR_RETRY_BASE_DELAY_MS * attempt;
              log("Validator scène: retry planifié", {
                phase,
                retryCount: state.retryCount,
                sceneId: scene.id,
                nextAttempt: attempt + 1,
                delayMs,
              });
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        }

        if (lastInvokeError) {
          llmInvokeFailed = true;
          llmIssues.push({
            issue: `Validation LLM indisponible pour cette scène: ${truncateForIssue(getErrorMessage(lastInvokeError), 180)}`,
            severity: "warning",
            suggestion:
              "Relancer la validation de cette scène; le résumé est conservé mais n'a pas pu être vérifié par le validateur LLM.",
          });
        }

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

        const gmIssues = findGMAsCharacterIssues(
          summaryTextForChecks,
          state.speakerMap
        ).map((issue) => ({
          issue,
          severity: "error" as const,
          suggestion:
            "Identifier quel PJ est reellement concerne en analysant le contexte du transcript (qui vient de parler, qui est blesse, a qui le MJ s'adresse).",
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
        const sceneIssues = [
          ...llmIssues,
          ...ruleBasedIssues,
          ...gmIssues,
        ];
        sceneIssues.push(...keyEventLineIssues);
        log("Validator scène: résultat", {
          phase,
          retryCount: state.retryCount,
          sceneId: scene.id,
          issuesCount: sceneIssues.length,
          ...summarizeIssueSeverities(sceneIssues),
          llmIssuesCount: llmIssues.length,
          llmInvokeFailed,
          mergedNamesIssuesCount: ruleBasedIssues.length,
          gmAttributionIssuesCount: gmIssues.length,
          keyEventLineIssuesCount: keyEventLineIssues.length,
          issuePreview: buildIssuePreview(sceneIssues),
        });

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

  // ── Global checks (cross-scene + GM coherence) — run in parallel ────────
  const allNarrativeSummaries = state.sceneSummaries
    .map((s) => {
      const scene = state.scenes.find((sc) => sc.id === s.sceneId);
      if (!scene || scene.type === "meta" || scene.type === "pause") return null;
      return { scene, summary: s };
    })
    .filter(
      (
        entry
      ): entry is {
        scene: (typeof state.scenes)[number];
        summary: (typeof state.sceneSummaries)[number];
      } => entry !== null
    );

  if (allNarrativeSummaries.length >= 1) {
    const sceneSummariesText = allNarrativeSummaries
      .map(
        ({ scene, summary }) =>
          `## Scène ${scene.id}: ${scene.title}\n` +
          `${summary.narrativeSummary}\n` +
          `Key events: ${summary.keyEvents.join(" | ")}`
      )
      .join("\n\n---\n\n");

    const globalChecks: Promise<void>[] = [];

    // ── 1. Cross-scene coherence ──────────────────────────────────────────
    if (allNarrativeSummaries.length >= 2) {
      globalChecks.push(
        (async () => {
          writer?.({
            event: "step:start",
            payload: {
              step: "validator_cross_scene",
              label: "Validation de cohérence inter-scènes...",
            },
          });

          try {
            const crossSceneModel = model.withStructuredOutput(
              CrossSceneValidationSchema
            );

            const crossResult = await crossSceneModel.invoke([
              new SystemMessage(
                `Tu es un relecteur expert en cohérence narrative pour les comptes-rendus de JDR.\n\n` +
                  `## Ta mission\n` +
                  `On te donne les résumés de TOUTES les scènes d'une session. Tu dois trouver les CONTRADICTIONS entre scènes.\n\n` +
                  `## Ce que tu cherches\n` +
                  `1. **Objets/possessions** : Si un objet est donné au personnage A dans la scène X, il ne peut pas appartenir au personnage B dans la scène Y (sauf transfert explicite)\n` +
                  `2. **Compétences/attributions** : Si le personnage A utilise une compétence dans la scène X, un autre personnage ne devrait pas être crédité pour cette même compétence propre dans la scène Y\n` +
                  `3. **Statut des personnages** : Blessures, soins, états — doivent être cohérents entre les scènes\n` +
                  `4. **Lieux** : Les personnages doivent être au bon endroit (pas de téléportation non expliquée)\n` +
                  `5. **Identités** : Un même personnage ne devrait pas changer de nom ou d'identité entre les scènes\n\n` +
                  `## Règles\n` +
                  `- Ne signale QUE les vraies contradictions entre scènes, pas les problèmes internes à une scène\n` +
                  `- Pour chaque contradiction, identifie la scène fautive (généralement la plus tardive, celle qui contredit un fait établi)\n` +
                  `- Sois concis et précis\n` +
                  `- Si aucune contradiction, retourne un tableau vide\n`
              ),
              new HumanMessage(
                `## Résumés de toutes les scènes\n\n${sceneSummariesText}\n\n` +
                  `Trouve les contradictions inter-scènes.`
              ),
            ]);

            if (crossResult.issues.length > 0) {
              log("Cross-scene issues found", {
                count: crossResult.issues.length,
              });
              for (const issue of crossResult.issues) {
                aggregatedIssues.push({
                  sceneId: issue.sceneIdToFix,
                  issue: `[Inter-scènes] ${issue.issue} (contradiction avec scène ${issue.contradictedBySceneId})`,
                  severity: issue.severity,
                  suggestion: issue.suggestion,
                });
              }
            }

            writer?.({
              event: "step:complete",
              payload: {
                step: "validator_cross_scene",
                label: `Cohérence inter-scènes — ${crossResult.issues.length} contradiction(s)`,
              },
            });
          } catch (crossErr) {
            log("Cross-scene validation error (non-fatal)", {
              error:
                crossErr instanceof Error
                  ? crossErr.message
                  : String(crossErr),
            });
            writer?.({
              event: "step:complete",
              payload: {
                step: "validator_cross_scene",
                label: "Cohérence inter-scènes — erreur (ignorée)",
              },
            });
          }
        })()
      );
    }

    // ── 2. GM coherence agent ─────────────────────────────────────────────
    globalChecks.push(
      (async () => {
        writer?.({
          event: "step:start",
          payload: {
            step: "validator_gm_coherence",
            label: "Vérification rôle du MJ (agent dédié)...",
          },
        });

        try {
          const gmModel = model.withStructuredOutput(GMCoherenceCheckSchema);

          const playerNames = (state.playerInfo ?? [])
            .filter((p) => p.characterName?.trim())
            .map((p) => `${p.characterName} (joueur: ${p.playerName})`)
            .join(", ");

          const gmResult = await gmModel.invoke([
            new SystemMessage(
              `Tu es un agent de vérification spécialisé. Ta SEULE mission : détecter si le MJ (Maître du Jeu) est traité comme un personnage dans les résumés de scènes.\n\n` +
                `## Règle fondamentale\n` +
                `Le MJ est le NARRATEUR du jeu de rôle. Il n'existe PAS dans le monde fictif. Le MJ :\n` +
                `- N'a PAS de corps, PAS de points de vie, PAS de caractéristiques\n` +
                `- Ne prend JAMAIS de dégâts, n'est JAMAIS blessé, n'est JAMAIS soigné\n` +
                `- N'utilise JAMAIS de sorts, sphères, compétences, pouvoirs, focus, armes\n` +
                `- Ne fait JAMAIS de jets de dés pour lui-même en tant que personnage\n` +
                `- N'a PAS d'inventaire, ne reçoit PAS d'objets en tant que personnage\n` +
                `- Ne combat PAS, n'esquive PAS, ne se déplace PAS comme un personnage\n\n` +
                `## Ce que le MJ PEUT faire (légitime)\n` +
                `- Décrire, narrer, raconter, expliquer, annoncer, demander\n` +
                `- Incarner un PNJ (mais les actions sont attribuées au PNJ, pas au MJ)\n` +
                `- Donner des informations, poser des questions, guider la narration\n` +
                `- Faire des jets de dés POUR des PNJs (attribués au PNJ, pas au MJ)\n\n` +
                `## Exemples de violations\n` +
                `- "Le MJ effectue une analyse via la sphère de Prime" → VIOLATION (le MJ n'utilise pas de sphères)\n` +
                `- "soigner le MJ" → VIOLATION (le MJ ne peut pas être soigné)\n` +
                `- "le MJ accepte avec soulagement pour effacer sa contusion" → VIOLATION (le MJ n'a pas de contusions)\n` +
                `- "le MJ lance les dés et obtient..." → OK SI c'est pour un PNJ\n` +
                `- "le MJ décrit la caverne" → OK (narration)\n\n` +
                `## PJs de la session\n` +
                `${playerNames || "Non spécifié"}\n\n` +
                `## Instructions\n` +
                `- Analyse chaque résumé de scène\n` +
                `- Signale TOUTE phrase où le MJ est sujet OU objet d'une action in-game\n` +
                `- Pour chaque violation, essaie de deviner quel PJ ou PNJ est réellement concerné\n` +
                `- Si aucune violation, retourne un tableau vide\n`
            ),
            new HumanMessage(
              `## Résumés à vérifier\n\n${sceneSummariesText}`
            ),
          ]);

          if (gmResult.issues.length > 0) {
            log("GM coherence issues found", {
              count: gmResult.issues.length,
            });
            for (const issue of gmResult.issues) {
              aggregatedIssues.push({
                sceneId: issue.sceneId,
                issue: `[MJ-comme-personnage] ${issue.issue} — passage: "${issue.passage.slice(0, 100)}"`,
                severity: "error",
                suggestion: `Remplacer "le MJ" par le personnage réellement concerné (probablement ${issue.likelyRealCharacter}). Analyser le transcript pour confirmer.`,
              });
            }
          }

          writer?.({
            event: "step:complete",
            payload: {
              step: "validator_gm_coherence",
              label: `Rôle du MJ — ${gmResult.issues.length} violation(s)`,
            },
          });
        } catch (gmErr) {
          log("GM coherence check error (non-fatal)", {
            error:
              gmErr instanceof Error ? gmErr.message : String(gmErr),
          });
          writer?.({
            event: "step:complete",
            payload: {
              step: "validator_gm_coherence",
              label: "Rôle du MJ — erreur (ignorée)",
            },
          });
        }
      })()
    );

    await Promise.all(globalChecks);
  }

  const hasErrors = aggregatedIssues.some((i) => i.severity === "error");
  const nextRetryCount = state.retryCount + 1;
  log("Fin nœud: validator", {
    isValid: !hasErrors,
    issuesCount: aggregatedIssues.length,
    errorsCount: aggregatedIssues.filter((i) => i.severity === "error").length,
    warningsCount: aggregatedIssues.filter((i) => i.severity === "warning")
      .length,
    infosCount: aggregatedIssues.filter((i) => i.severity === "info").length,
    retryCount: nextRetryCount,
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
  const canRetry = pendingSceneIds.length > 0 && nextRetryCount < MAX_RETRIES;
  log("Décision corrective: validator", {
    phase,
    retryCount: nextRetryCount,
    hasErrors,
    pendingScenesCount: pendingSceneIds.length,
    pendingSceneIds,
    canRetry,
    nextNode: canRetry ? "summarizer" : "formatter",
  });

  return {
    validationReport: {
      isValid: !hasErrors,
      issues: aggregatedIssues,
    },
    retryCount: nextRetryCount,
    ...(canRetry
      ? {
          pendingSceneIds,
          currentSceneIndex: 0,
        }
      : {}),
    currentStep: "validator_complete",
  };
}
