import { WorkflowStateType } from "../graph/state.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

export function formatterNode(
  state: WorkflowStateType
): Partial<WorkflowStateType> {
  log("Début nœud: formatter (assemblage code)", {
    scenesCount: state.sceneSummaries.length,
  });

  const orderedSummaries = [...state.sceneSummaries].sort(
    (a, b) => a.sceneId - b.sceneId
  );

  const parts: string[] = [];

  // ── Header ──

  parts.push(`# Compte-Rendu de Session — ${state.universeName || "JDR"}`);
  parts.push("");

  if (state.playerInfo.length > 0) {
    parts.push("| Joueur | Personnage |");
    parts.push("|--------|------------|");
    for (const p of state.playerInfo) {
      parts.push(`| ${p.playerName} | ${p.characterName} |`);
    }
    parts.push("");
  }

  // ── Global summary from analyst scene summaries ──

  const sceneSynopses = state.scenes
    .filter((s) => s.type !== "meta" && s.type !== "pause" && s.summary)
    .map((s) => s.summary!);

  if (sceneSynopses.length > 0) {
    parts.push("## Résumé de la session");
    parts.push("");
    parts.push(sceneSynopses.join(" "));
    parts.push("");
  }

  // ── Scenes ──

  for (const summary of orderedSummaries) {
    const scene = state.scenes.find((s) => s.id === summary.sceneId);
    if (!scene || scene.type === "meta" || scene.type === "pause") continue;

    parts.push("---");
    parts.push("");
    parts.push(`## ${scene.title}`);
    parts.push("");

    if (scene.location) {
      parts.push(`*📍 ${scene.location}*`);
      parts.push("");
    }

    parts.push(summary.narrativeSummary);
    parts.push("");

    const hasDiceRolls = summary.diceRolls.length > 0;
    const hasNpcs = summary.npcsInvolved.length > 0;
    const techNotes = summary.technicalNotes ?? [];
    const hasTechNotes = techNotes.length > 0;

    if (hasDiceRolls || hasNpcs || hasTechNotes) {
      if (hasDiceRolls) {
        parts.push("> **🎲 Jets de dés**");
        for (const d of summary.diceRolls) {
          parts.push(
            `> - **${d.character}** — ${d.skill} : ${d.result} *(${d.context})*`
          );
        }
        parts.push(">");
      }

      if (hasNpcs) {
        parts.push(
          `> **👥 PNJs impliqués** : ${summary.npcsInvolved.join(", ")}`
        );
        parts.push(">");
      }

      if (hasTechNotes) {
        parts.push("> **📝 Notes techniques**");
        for (const n of techNotes) {
          parts.push(`> - ${n}`);
        }
      }

      parts.push("");
    }
  }

  // ── Annexes ──

  parts.push("---");
  parts.push("");
  parts.push("## Annexes");
  parts.push("");

  if (state.entities.npcs.length > 0) {
    parts.push("### PNJs rencontrés");
    parts.push("");
    for (const npc of state.entities.npcs) {
      let line = `- **${npc.name}**`;
      if (npc.role) line += ` — ${npc.role}`;
      if (npc.description) line += ` : ${npc.description}`;
      parts.push(line);
    }
    parts.push("");
  }

  if (state.entities.locations.length > 0) {
    parts.push("### Lieux visités");
    parts.push("");
    for (const loc of state.entities.locations) {
      parts.push(`- ${loc}`);
    }
    parts.push("");
  }

  const finalReport = parts.join("\n");

  log("Fin nœud: formatter", { reportLength: finalReport.length });

  return {
    finalReport,
    currentStep: "formatter_complete",
  };
}
