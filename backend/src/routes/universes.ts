/**
 * Univers (lore en markdown : intégrés dans config/universes, personnalisés dans data/universes)
 * et brouillon d'éditeur par univers (lore, historique, table par défaut).
 */
import { Router } from "express";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dataDir, deleteEditorDraft, getEditorDraft, upsertEditorDraft } from "../config/database.js";
import { parsePlayerDraft, type PlayerDraft } from "../report/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const bundledDir = resolve(__dirname, "../config/universes");
const customDir = resolve(dataDir, "universes");

interface Universe {
  id: string;
  label: string;
  defaultPrompt: string;
  isCustom: boolean;
}

export function safeUniverseId(id: string): string | null {
  if (!id || typeof id !== "string") return null;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return slug.length > 0 ? slug : null;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function readDir(dir: string, isCustom: boolean): Universe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const content = readFileSync(join(dir, f), "utf-8");
      const id = f.replace(/\.md$/, "");
      return { id, label: content.match(/^#\s+(.+)/m)?.[1] ?? id, defaultPrompt: content, isCustom };
    });
}

function readUniverses(): Universe[] {
  // Les univers personnalisés remplacent un univers intégré de même identifiant.
  const byId = new Map<string, Universe>();
  for (const u of [...readDir(bundledDir, false), ...readDir(customDir, true)]) byId.set(u.id, u);
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, "fr", { sensitivity: "base" }));
}

const customPath = (id: string) => join(customDir, `${id}.md`);
const isCustom = (id: string) => existsSync(customPath(id));
const isBundled = (id: string) => existsSync(join(bundledDir, `${id}.md`));

function withTitle(markdown: string, label: string): string {
  const normalized = markdown.trim().replace(/\r\n/g, "\n");
  if (!normalized) return `# ${label}\n`;
  const lines = normalized.split("\n");
  if (/^#\s+/.test(lines[0])) {
    lines[0] = `# ${label}`;
    return `${lines.join("\n")}\n`;
  }
  return `# ${label}\n\n${normalized}\n`;
}

export const universesRouter = Router();

universesRouter.get("/", (_req, res) => {
  try {
    res.json(readUniverses());
  } catch {
    res.json([]);
  }
});

universesRouter.post("/", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const defaultPrompt = typeof req.body?.defaultPrompt === "string" ? req.body.defaultPrompt : "";
  const id = slugify((typeof req.body?.id === "string" ? req.body.id.trim() : "") || label);

  if (!label) return void res.status(400).json({ message: "Le nom de l'univers est requis." });
  if (!defaultPrompt.trim()) return void res.status(400).json({ message: "Le contenu du lore est requis." });
  if (!id) return void res.status(400).json({ message: "Nom d'univers invalide : utilise des lettres ou des chiffres." });
  if (isCustom(id) || isBundled(id)) {
    return void res.status(409).json({ message: `Un univers avec l'identifiant « ${id} » existe déjà.` });
  }

  try {
    mkdirSync(customDir, { recursive: true });
    const content = withTitle(defaultPrompt, label);
    writeFileSync(customPath(id), content, { encoding: "utf-8", flag: "wx" });
    res.status(201).json({ id, label, defaultPrompt: content, isCustom: true });
  } catch (error) {
    if ((error as { code?: string })?.code === "EEXIST") {
      return void res.status(409).json({ message: `Un univers avec l'identifiant « ${id} » existe déjà.` });
    }
    res.status(500).json({ message: "Impossible de créer le fichier univers." });
  }
});

universesRouter.patch("/:id", (req, res) => {
  const id = safeUniverseId(req.params.id ?? "");
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!id) return void res.status(400).json({ message: "Identifiant univers invalide." });
  if (!label) return void res.status(400).json({ message: "Le nom de l'univers est requis." });
  if (!isCustom(id)) {
    return void res
      .status(isBundled(id) ? 403 : 404)
      .json({ message: isBundled(id) ? "Les univers intégrés ne peuvent pas être renommés." : "Univers introuvable." });
  }
  try {
    const content = withTitle(readFileSync(customPath(id), "utf-8"), label);
    writeFileSync(customPath(id), content, "utf-8");
    res.json({ id, label, defaultPrompt: content, isCustom: true });
  } catch {
    res.status(500).json({ message: "Impossible de renommer cet univers." });
  }
});

universesRouter.delete("/:id", (req, res) => {
  const id = safeUniverseId(req.params.id ?? "");
  if (!id) return void res.status(400).json({ message: "Identifiant univers invalide." });
  if (!isCustom(id)) {
    return void res
      .status(isBundled(id) ? 403 : 404)
      .json({ message: isBundled(id) ? "Les univers intégrés ne peuvent pas être supprimés." : "Univers introuvable." });
  }
  try {
    unlinkSync(customPath(id));
    deleteEditorDraft(id);
    res.json({ message: "Univers supprimé." });
  } catch {
    res.status(500).json({ message: "Impossible de supprimer cet univers." });
  }
});

// ── Brouillon d'éditeur (lore, historique, table par défaut) ─────────────────

universesRouter.get("/:id/draft", (req, res) => {
  const id = safeUniverseId(req.params.id ?? "");
  if (!id) return void res.status(400).json({ message: "Identifiant univers invalide." });
  const draft = getEditorDraft(id);
  if (!draft) return void res.status(404).json({ message: "Aucun brouillon enregistré pour cet univers." });
  res.json(draft);
});

universesRouter.put("/:id/draft", (req, res) => {
  const id = safeUniverseId(req.params.id ?? "");
  if (!id) return void res.status(400).json({ message: "Identifiant univers invalide." });
  const universeContext = typeof req.body?.universeContext === "string" ? req.body.universeContext : "";
  const sessionHistory = typeof req.body?.sessionHistory === "string" ? req.body.sessionHistory : "";
  const rows: unknown[] = Array.isArray(req.body?.defaultPlayers) ? req.body.defaultPlayers : [];
  const players = rows.map(parsePlayerDraft).filter((p): p is PlayerDraft => p !== null);
  const draft = { universeContext, sessionHistory, defaultPlayers: players.length ? players : undefined };
  try {
    upsertEditorDraft(id, draft);
    res.json(draft);
  } catch {
    res.status(500).json({ message: "Impossible d'enregistrer le brouillon." });
  }
});
