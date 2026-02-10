export interface PlayerInfoDraft {
  playerName: string;
  characterName: string;
  speakerHint?: string;
}

export interface UniverseEditorDraft {
  universeContext: string;
  sessionHistory: string;
  defaultPlayers?: PlayerInfoDraft[];
}

export interface UniverseEditorStorage {
  selectedUniverse: string | null;
  drafts: Record<string, UniverseEditorDraft>;
}

const UNIVERSE_EDITOR_STORAGE_KEY = "cr-session.universe-editor.v1";

function getEmptyStorage(): UniverseEditorStorage {
  return {
    selectedUniverse: null,
    drafts: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePlayerDraft(item: unknown): PlayerInfoDraft | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const playerName = typeof o.playerName === "string" ? o.playerName : "";
  const characterName = typeof o.characterName === "string" ? o.characterName : "";
  if (!playerName.trim() && !characterName.trim()) return null;
  return {
    playerName: playerName.trim(),
    characterName: characterName.trim(),
    speakerHint: typeof o.speakerHint === "string" ? o.speakerHint : undefined,
  };
}

function toUniverseEditorDraft(value: unknown): UniverseEditorDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.universeContext !== "string") {
    return null;
  }

  const defaultPlayers: PlayerInfoDraft[] = [];
  if (Array.isArray(value.defaultPlayers)) {
    for (const item of value.defaultPlayers) {
      const p = parsePlayerDraft(item);
      if (p) defaultPlayers.push(p);
    }
  }

  return {
    universeContext: value.universeContext,
    sessionHistory:
      typeof value.sessionHistory === "string" ? value.sessionHistory : "",
    defaultPlayers: defaultPlayers.length > 0 ? defaultPlayers : undefined,
  };
}

export function loadUniverseEditorStorage(): UniverseEditorStorage {
  if (typeof window === "undefined") {
    return getEmptyStorage();
  }

  try {
    const raw = window.localStorage.getItem(UNIVERSE_EDITOR_STORAGE_KEY);
    if (!raw) {
      return getEmptyStorage();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return getEmptyStorage();
    }

    const drafts: Record<string, UniverseEditorDraft> = {};
    const rawDrafts = parsed.drafts;

    if (isRecord(rawDrafts)) {
      for (const [universeId, value] of Object.entries(rawDrafts)) {
        const draft = toUniverseEditorDraft(value);
        if (draft) {
          drafts[universeId] = draft;
        }
      }
    }

    const selectedUniverse =
      typeof parsed.selectedUniverse === "string" && parsed.selectedUniverse.trim()
        ? parsed.selectedUniverse
        : null;

    return {
      selectedUniverse,
      drafts,
    };
  } catch {
    return getEmptyStorage();
  }
}

export function saveUniverseEditorStorage(value: UniverseEditorStorage): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    UNIVERSE_EDITOR_STORAGE_KEY,
    JSON.stringify(value)
  );
}
