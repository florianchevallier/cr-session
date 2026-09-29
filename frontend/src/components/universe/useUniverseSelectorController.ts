import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerInfo, Universe } from "../../lib/api";
import {
  createUniverse,
  deleteUniverse,
  fetchUniverseDraft,
  fetchUniverses,
  renameUniverse,
  saveUniverseDraft,
} from "../../lib/api";
import { buildUniverseContextPrompt } from "../../lib/universeContextPrompt";
import { loadSelectedUniverse, saveSelectedUniverse } from "../../lib/universeEditorStorage";
import type { UniverseDraft as UniverseEditorDraft } from "../../lib/api";

const DRAFT_SAVE_DEBOUNCE_MS = 800;

export type ActivePanel = "none" | "add" | "rename";

export type UniverseSelectorUiState = {
  isExpanded: boolean;
  promptCopied: boolean;
  isLoadingUniverses: boolean;
  activePanel: ActivePanel;
  isDeletingUniverse: boolean;
  managementError: string | null;
};

const INITIAL_UI_STATE: UniverseSelectorUiState = {
  isExpanded: false,
  promptCopied: false,
  isLoadingUniverses: false,
  activePanel: "none",
  isDeletingUniverse: false,
  managementError: null,
};

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fallback for environments where Clipboard API is unavailable.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

interface UseUniverseSelectorControllerParams {
  selectedUniverse: string;
  universeContext: string;
  sessionHistory: string;
  players: PlayerInfo[];
  onUniverseChange: (id: string) => void;
  onContextChange: (context: string) => void;
  onSessionHistoryChange: (history: string) => void;
  onDefaultPlayersChange?: (players: PlayerInfo[]) => void;
}

export function useUniverseSelectorController({
  selectedUniverse,
  universeContext,
  sessionHistory,
  players,
  onUniverseChange,
  onContextChange,
  onSessionHistoryChange,
  onDefaultPlayersChange,
}: UseUniverseSelectorControllerParams) {
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [ui, setUi] = useState<UniverseSelectorUiState>(INITIAL_UI_STATE);
  const patchUi = useCallback((partial: Partial<UniverseSelectorUiState>) => {
    setUi((prev) => ({ ...prev, ...partial }));
  }, []);

  const hasInitializedFetchRef = useRef(false);
  const hasCompletedInitialLoadRef = useRef(false);
  const saveDraftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultPlayersForCurrentUniverseRef = useRef<PlayerInfo[]>([]);

  const persistSelectedUniverse = useCallback((universeId: string) => {
    saveSelectedUniverse(universeId);
  }, []);

  const removeUniverseFromStorage = useCallback((universeId: string) => {
    if (loadSelectedUniverse() === universeId) saveSelectedUniverse(null);
  }, []);

  /** Enregistre le brouillon sur le serveur, avec un délai pour regrouper les frappes. */
  const persistUniverseDraft = useCallback((universeId: string, draft: UniverseEditorDraft) => {
    if (saveDraftTimeoutRef.current) clearTimeout(saveDraftTimeoutRef.current);
    saveDraftTimeoutRef.current = setTimeout(() => {
      saveDraftTimeoutRef.current = null;
      saveUniverseDraft(universeId, draft).catch(() => {
        // Échec réseau ponctuel : le prochain changement renverra le brouillon complet.
      });
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, []);

  const applyUniverseSelection = useCallback(
    (
      universeId: string,
      availableUniverses: Universe[],
      serverDraft?: UniverseEditorDraft | null
    ) => {
      const universe = availableUniverses.find((u) => u.id === universeId);
      const context = serverDraft?.universeContext ?? universe?.defaultPrompt ?? "";
      const history = serverDraft?.sessionHistory ?? "";
      const defaultPlayers = serverDraft?.defaultPlayers ?? [];

      defaultPlayersForCurrentUniverseRef.current = defaultPlayers;
      onUniverseChange(universeId);
      onContextChange(context);
      onSessionHistoryChange(history);
      onDefaultPlayersChange?.(defaultPlayers.length > 0 ? defaultPlayers : []);
      persistSelectedUniverse(universeId);
    },
    [
      onContextChange,
      onDefaultPlayersChange,
      onSessionHistoryChange,
      onUniverseChange,
      persistSelectedUniverse,
    ]
  );

  const loadUniverses = useCallback(
    async (preferredUniverseId?: string) => {
      patchUi({ isLoadingUniverses: true });

      try {
        const data = await fetchUniverses();
        setUniverses(data);
        if (data.length === 0) return;

        const storedSelection = loadSelectedUniverse();
        const availableUniverseIds = new Set(data.map((u) => u.id));
        const resolvedUniverseId =
          (preferredUniverseId && availableUniverseIds.has(preferredUniverseId)
            ? preferredUniverseId
            : null) ??
          (storedSelection && availableUniverseIds.has(storedSelection) ? storedSelection : null) ??
          (selectedUniverse && availableUniverseIds.has(selectedUniverse)
            ? selectedUniverse
            : null) ??
          data[0].id;

        let serverDraft: UniverseEditorDraft | null = null;
        try {
          serverDraft = await fetchUniverseDraft(resolvedUniverseId);
        } catch {
          // Serveur injoignable : lore par défaut de l'univers.
        }

        applyUniverseSelection(resolvedUniverseId, data, serverDraft);
      } catch {
        setUniverses([]);
      } finally {
        patchUi({ isLoadingUniverses: false });
      }
    },
    [applyUniverseSelection, patchUi, selectedUniverse]
  );

  useEffect(() => {
    if (hasInitializedFetchRef.current) {
      return;
    }

    hasInitializedFetchRef.current = true;
    void loadUniverses().finally(() => {
      hasCompletedInitialLoadRef.current = true;
    });
  }, [loadUniverses]);

  useEffect(() => {
    return () => {
      if (saveDraftTimeoutRef.current) clearTimeout(saveDraftTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hasCompletedInitialLoadRef.current || !selectedUniverse) {
      return;
    }

    persistUniverseDraft(selectedUniverse, {
      universeContext,
      sessionHistory,
      defaultPlayers: defaultPlayersForCurrentUniverseRef.current,
    });
  }, [
    persistUniverseDraft,
    selectedUniverse,
    sessionHistory,
    universeContext,
  ]);

  const handleUniverseChange = useCallback(
    async (universeId: string) => {
      patchUi({ activePanel: "none", managementError: null });

      let serverDraft: UniverseEditorDraft | null = null;
      try {
        serverDraft = await fetchUniverseDraft(universeId);
      } catch {
        // Serveur injoignable : lore par défaut de l'univers.
      }

      applyUniverseSelection(universeId, universes, serverDraft);
    },
    [applyUniverseSelection, patchUi, universes]
  );

  const getCurrentDraft = useCallback(
    (overrides?: {
      universeContext?: string;
      sessionHistory?: string;
      defaultPlayers?: PlayerInfo[];
    }): UniverseEditorDraft => ({
      universeContext: overrides?.universeContext ?? universeContext,
      sessionHistory: overrides?.sessionHistory ?? sessionHistory,
      defaultPlayers:
        overrides?.defaultPlayers ?? defaultPlayersForCurrentUniverseRef.current,
    }),
    [sessionHistory, universeContext]
  );

  const handleContextChange = useCallback(
    (value: string) => {
      onContextChange(value);
      if (!selectedUniverse) {
        return;
      }
      persistUniverseDraft(
        selectedUniverse,
        getCurrentDraft({ universeContext: value })
      );
    },
    [getCurrentDraft, onContextChange, persistUniverseDraft, selectedUniverse]
  );

  const handleSessionHistoryChange = useCallback(
    (value: string) => {
      onSessionHistoryChange(value);
      if (!selectedUniverse) {
        return;
      }
      persistUniverseDraft(
        selectedUniverse,
        getCurrentDraft({ sessionHistory: value })
      );
    },
    [getCurrentDraft, onSessionHistoryChange, persistUniverseDraft, selectedUniverse]
  );

  const handleSaveDefaultPlayers = useCallback(() => {
    if (!selectedUniverse) return;
    const toSave = players.filter(
      (p) => p.playerName.trim() !== "" || p.characterName.trim() !== ""
    );
    defaultPlayersForCurrentUniverseRef.current = toSave;
    persistUniverseDraft(
      selectedUniverse,
      getCurrentDraft({ defaultPlayers: toSave })
    );
  }, [getCurrentDraft, persistUniverseDraft, players, selectedUniverse]);

  const handleCreateUniverse = useCallback(
    async (input: { label: string; prompt: string }) => {
      const createdUniverse = await createUniverse({
        label: input.label,
        defaultPrompt: input.prompt,
      });

      persistUniverseDraft(createdUniverse.id, {
        universeContext: createdUniverse.defaultPrompt,
        sessionHistory: "",
        defaultPlayers: [],
      });

      await loadUniverses(createdUniverse.id);
      patchUi({ activePanel: "none", managementError: null });
    },
    [loadUniverses, patchUi, persistUniverseDraft]
  );

  const currentUniverse = universes.find((u) => u.id === selectedUniverse) ?? null;
  const canManageCurrentUniverse = !!currentUniverse?.isCustom;

  const handleRenameUniverse = useCallback(
    async (label: string) => {
      if (!currentUniverse?.isCustom) {
        throw new Error("Seuls les univers personnalisés peuvent être renommés.");
      }

      const updated = await renameUniverse(currentUniverse.id, label);
      setUniverses((prev) =>
        prev.map((universe) =>
          universe.id === updated.id ? updated : universe
        )
      );
      patchUi({ activePanel: "none", managementError: null });
    },
    [currentUniverse, patchUi]
  );

  const handleDeleteUniverse = useCallback(async () => {
    if (!currentUniverse?.isCustom) {
      patchUi({
        managementError: "Seuls les univers personnalisés peuvent être supprimés.",
      });
      return;
    }

    const confirmed = window.confirm(
      `Supprimer l'univers "${currentUniverse.label}" ? Cette action est irréversible.`
    );
    if (!confirmed) return;

    const universeId = currentUniverse.id;
    patchUi({
      isDeletingUniverse: true,
      managementError: null,
      activePanel: "none",
    });

    if (saveDraftTimeoutRef.current) {
      clearTimeout(saveDraftTimeoutRef.current);
      saveDraftTimeoutRef.current = null;
    }

    try {
      await deleteUniverse(universeId);
      removeUniverseFromStorage(universeId);
      await loadUniverses();
    } catch (error) {
      patchUi({
        managementError:
          error instanceof Error
            ? error.message
            : "Impossible de supprimer cet univers.",
      });
    } finally {
      patchUi({ isDeletingUniverse: false });
    }
  }, [currentUniverse, loadUniverses, patchUi, removeUniverseFromStorage]);

  const copyUniversePrompt = useCallback(async () => {
    const selectedUniverseLabel =
      universes.find((u) => u.id === selectedUniverse)?.label || selectedUniverse;
    const prompt = buildUniverseContextPrompt(selectedUniverseLabel);
    await copyTextToClipboard(prompt);
    patchUi({ promptCopied: true });
    window.setTimeout(() => patchUi({ promptCopied: false }), 2000);
  }, [patchUi, selectedUniverse, universes]);

  const openAddPanel = useCallback(() => {
    patchUi({ managementError: null, activePanel: "add" });
  }, [patchUi]);

  const openRenamePanel = useCallback(() => {
    patchUi({ managementError: null, activePanel: "rename" });
  }, [patchUi]);

  const closeActivePanel = useCallback(() => {
    patchUi({ activePanel: "none" });
  }, [patchUi]);

  const toggleExpanded = useCallback(() => {
    setUi((prev) => ({ ...prev, isExpanded: !prev.isExpanded }));
  }, []);

  const refreshUniverses = useCallback(async () => {
    await loadUniverses();
  }, [loadUniverses]);

  return {
    universes,
    ui,
    currentUniverse,
    canManageCurrentUniverse,
    handleUniverseChange,
    handleContextChange,
    handleSessionHistoryChange,
    handleSaveDefaultPlayers,
    handleCreateUniverse,
    handleRenameUniverse,
    handleDeleteUniverse,
    copyUniversePrompt,
    openAddPanel,
    openRenamePanel,
    closeActivePanel,
    toggleExpanded,
    refreshUniverses,
  };
}
