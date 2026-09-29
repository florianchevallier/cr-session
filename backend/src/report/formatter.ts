import type { ReportState } from "./types.js";

/** « Nom : description » → « **Nom** : description » (texte laissé tel quel sans séparateur). */
function boldLabel(text: string): string {
  const idx = text.indexOf(" : ");
  if (idx <= 0 || idx > 80) return text;
  return `**${text.slice(0, idx)}** : ${text.slice(idx + 3)}`;
}

/** Assemble le markdown du compte-rendu (code pur, sans LLM). */
export function formatReport(state: ReportState): string {
  const orderedSummaries = [...state.sceneSummaries].sort(
    (a, b) => a.sceneId - b.sceneId
  );

  const parts: string[] = [];

  // ── Header ──

  parts.push(`# ${state.sessionTitle?.trim() || `Compte-Rendu de Session — ${state.universeName || "JDR"}`}`);
  parts.push("");

  if (state.playerInfo.length > 0) {
    parts.push("| Joueur | Personnage |");
    parts.push("|--------|------------|");
    for (const p of state.playerInfo) {
      parts.push(`| ${p.playerName} | ${p.characterName} |`);
    }
    parts.push("");
  }

  // ── Global summary from scene synopses ──

  const sceneSynopses = state.scenes
    .filter((s) => s.type !== "meta" && s.type !== "pause" && s.summary)
    .map((s) => s.summary!);

  if (sceneSynopses.length > 0) {
    parts.push("## Résumé de la session");
    parts.push("");
    parts.push(sceneSynopses.join(" "));
    parts.push("");
  }

  // ── Chapters ──

  let chapterNumber = 0;
  for (const summary of orderedSummaries) {
    const scene = state.scenes.find((s) => s.id === summary.sceneId);
    if (!scene || scene.type === "meta" || scene.type === "pause") continue;
    chapterNumber++;

    parts.push(`## Chapitre ${chapterNumber} : ${scene.title}`);
    parts.push("");

    if (scene.location) {
      parts.push(`*📍 ${scene.location}*`);
      parts.push("");
    }

    parts.push(summary.narrativeSummary);
    parts.push("");

    const boxes: string[][] = [];

    if (summary.diceRolls.length > 0) {
      boxes.push([
        "> **🎲 Jets de dés**",
        ">",
        ...summary.diceRolls.map(
          (d) => `> - **${d.character}** — ${d.skill} : **${d.result}** — *${d.context}*`
        ),
      ]);
    }

    if (summary.npcsInvolved.length > 0) {
      boxes.push(["> **👥 PNJs impliqués**", ">", ...summary.npcsInvolved.map((n) => `> - ${boldLabel(n)}`)]);
    }

    const techNotes = summary.technicalNotes ?? [];
    if (techNotes.length > 0) {
      boxes.push(["> **📝 Notes techniques**", ">", ...techNotes.map((n) => `> - ${boldLabel(n)}`)]);
    }

    for (const box of boxes) {
      parts.push("---");
      parts.push("");
      parts.push(...box);
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

  return parts.join("\n");
}
