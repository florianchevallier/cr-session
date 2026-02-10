import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe,
  ChevronDown,
  Copy,
  CheckCheck,
  RefreshCw,
  Plus,
} from "lucide-react";
import type { PlayerInfo, Universe } from "../lib/api";
import {
  createUniverse,
  fetchUniverseDraft,
  fetchUniverses,
  saveUniverseDraft,
} from "../lib/api";
import { buildUniverseContextPrompt } from "../lib/universeContextPrompt";
import {
  loadUniverseEditorStorage,
  saveUniverseEditorStorage,
} from "../lib/universeEditorStorage";
import type { UniverseEditorDraft } from "../lib/universeEditorStorage";

const DRAFT_SAVE_DEBOUNCE_MS = 800;

interface UniverseSelectorProps {
  selectedUniverse: string;
  universeContext: string;
  sessionHistory: string;
  players?: PlayerInfo[];
  onUniverseChange: (id: string) => void;
  onContextChange: (context: string) => void;
  onSessionHistoryChange: (history: string) => void;
  onDefaultPlayersChange?: (players: PlayerInfo[]) => void;
}

export default function UniverseSelector({
  selectedUniverse,
  universeContext,
  sessionHistory,
  players = [],
  onUniverseChange,
  onContextChange,
  onSessionHistoryChange,
  onDefaultPlayersChange,
}: UniverseSelectorProps) {
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [isLoadingUniverses, setIsLoadingUniverses] = useState(false);
  const [isAddUniverseOpen, setIsAddUniverseOpen] = useState(false);
  const [newUniverseLabel, setNewUniverseLabel] = useState("");
  const [newUniversePrompt, setNewUniversePrompt] = useState("");
  const [isCreatingUniverse, setIsCreatingUniverse] = useState(false);
  const [createUniverseError, setCreateUniverseError] = useState<string | null>(
    null
  );
  const hasInitializedFetchRef = useRef(false);
  const hasCompletedInitialLoadRef = useRef(false);
  const saveDraftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultPlayersForCurrentUniverseRef = useRef<PlayerInfo[]>([]);

  const persistSelectedUniverse = useCallback((universeId: string) => {
    try {
      const stored = loadUniverseEditorStorage();
      if (stored.selectedUniverse === universeId) {
        return;
      }

      saveUniverseEditorStorage({
        selectedUniverse: universeId,
        drafts: stored.drafts,
      });
    } catch {
      // Ignore storage quota/unavailability and keep the selector usable.
    }
  }, []);

  const persistUniverseDraft = useCallback(
    (universeId: string, draft: UniverseEditorDraft) => {
      try {
        const stored = loadUniverseEditorStorage();
        saveUniverseEditorStorage({
          selectedUniverse: universeId,
          drafts: {
            ...stored.drafts,
            [universeId]: draft,
          },
        });
      } catch {
        // Ignore storage quota/unavailability.
      }
      if (saveDraftTimeoutRef.current) clearTimeout(saveDraftTimeoutRef.current);
      saveDraftTimeoutRef.current = setTimeout(() => {
        saveDraftTimeoutRef.current = null;
        saveUniverseDraft(universeId, draft).catch(() => {
          // Fail silently; localStorage already updated.
        });
      }, DRAFT_SAVE_DEBOUNCE_MS);
    },
    []
  );

  const applyUniverseSelection = useCallback(
    (
      id: string,
      availableUniverses: Universe[],
      serverDraft?: UniverseEditorDraft | null
    ) => {
      const universe = availableUniverses.find((u) => u.id === id);
      const stored = loadUniverseEditorStorage();
      const storedDraft = stored.drafts[id];
      const context =
        serverDraft?.universeContext ??
        storedDraft?.universeContext ??
        universe?.defaultPrompt ??
        "";
      const history =
        serverDraft?.sessionHistory ?? storedDraft?.sessionHistory ?? "";
      const defaultPlayers =
        serverDraft?.defaultPlayers ?? storedDraft?.defaultPlayers ?? [];

      defaultPlayersForCurrentUniverseRef.current = defaultPlayers;
      onUniverseChange(id);
      onContextChange(context);
      onSessionHistoryChange(history);
      onDefaultPlayersChange?.(defaultPlayers.length > 0 ? defaultPlayers : []);
      persistSelectedUniverse(id);
    },
    [
      onContextChange,
      onSessionHistoryChange,
      onUniverseChange,
      onDefaultPlayersChange,
      persistSelectedUniverse,
    ]
  );

  const loadUniverses = useCallback(async (preferredUniverseId?: string) => {
    setIsLoadingUniverses(true);

    try {
      const data = await fetchUniverses();
      setUniverses(data);

      if (data.length === 0) {
        return;
      }

      const stored = loadUniverseEditorStorage();
      const availableUniverseIds = new Set(data.map((u) => u.id));
      const resolvedUniverseId =
        (preferredUniverseId && availableUniverseIds.has(preferredUniverseId)
          ? preferredUniverseId
          : null) ??
        (stored.selectedUniverse &&
        availableUniverseIds.has(stored.selectedUniverse)
          ? stored.selectedUniverse
          : null) ??
        (selectedUniverse && availableUniverseIds.has(selectedUniverse)
          ? selectedUniverse
          : null) ??
        data[0].id;

      let serverDraft: UniverseEditorDraft | null = null;
      try {
        serverDraft = await fetchUniverseDraft(resolvedUniverseId);
      } catch {
        // Use localStorage + defaults if API fails.
      }
      applyUniverseSelection(resolvedUniverseId, data, serverDraft);
    } catch {
      setUniverses([]);
    } finally {
      setIsLoadingUniverses(false);
    }
  }, [applyUniverseSelection, selectedUniverse]);

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
    async (id: string) => {
      let serverDraft: UniverseEditorDraft | null = null;
      try {
        serverDraft = await fetchUniverseDraft(id);
      } catch {
        // Use localStorage + defaults if API fails.
      }
      applyUniverseSelection(id, universes, serverDraft);
    },
    [applyUniverseSelection, universes]
  );

  const getCurrentDraft = useCallback(
    (overrides?: {
      universeContext?: string;
      sessionHistory?: string;
      defaultPlayers?: PlayerInfo[];
    }): UniverseEditorDraft =>
      ({
        universeContext: overrides?.universeContext ?? universeContext,
        sessionHistory: overrides?.sessionHistory ?? sessionHistory,
        defaultPlayers:
          overrides?.defaultPlayers ?? defaultPlayersForCurrentUniverseRef.current,
      }),
    [universeContext, sessionHistory]
  );

  const handleContextChange = (value: string) => {
    onContextChange(value);
    if (!selectedUniverse) {
      return;
    }

    persistUniverseDraft(selectedUniverse, getCurrentDraft({ universeContext: value }));
  };

  const handleSessionHistoryChange = (value: string) => {
    onSessionHistoryChange(value);
    if (!selectedUniverse) {
      return;
    }

    persistUniverseDraft(selectedUniverse, getCurrentDraft({ sessionHistory: value }));
  };

  const handleSaveDefaultPlayers = useCallback(() => {
    if (!selectedUniverse) return;
    const toSave = players.filter(
      (p) => p.playerName.trim() !== "" || p.characterName.trim() !== ""
    );
    defaultPlayersForCurrentUniverseRef.current = toSave;
    persistUniverseDraft(selectedUniverse, getCurrentDraft({ defaultPlayers: toSave }));
  }, [selectedUniverse, players, getCurrentDraft, persistUniverseDraft]);

  const openAddUniversePanel = () => {
    setIsAddUniverseOpen(true);
    setCreateUniverseError(null);
    setNewUniverseLabel("");
    setNewUniversePrompt("");
  };

  const closeAddUniversePanel = () => {
    if (isCreatingUniverse) {
      return;
    }
    setIsAddUniverseOpen(false);
    setCreateUniverseError(null);
  };

  const handleCreateUniverse = async () => {
    const label = newUniverseLabel.trim();
    const prompt = newUniversePrompt.trim();

    if (!label) {
      setCreateUniverseError("Le nom de l'univers est obligatoire.");
      return;
    }

    if (!prompt) {
      setCreateUniverseError("Le contenu du pre-prompt / lore est obligatoire.");
      return;
    }

    setIsCreatingUniverse(true);
    setCreateUniverseError(null);

    try {
      const createdUniverse = await createUniverse({
        label,
        defaultPrompt: prompt,
      });

      persistUniverseDraft(createdUniverse.id, {
        universeContext: createdUniverse.defaultPrompt,
        sessionHistory: "",
        defaultPlayers: [],
      });
      await loadUniverses(createdUniverse.id);

      setIsAddUniverseOpen(false);
      setNewUniverseLabel("");
      setNewUniversePrompt("");
      setCreateUniverseError(null);
    } catch (error) {
      setCreateUniverseError(
        error instanceof Error
          ? error.message
          : "Impossible de creer le nouvel univers."
      );
    } finally {
      setIsCreatingUniverse(false);
    }
  };

  const copyUniversePrompt = async () => {
    const selectedUniverseLabel =
      universes.find((u) => u.id === selectedUniverse)?.label || selectedUniverse;
    const prompt = buildUniverseContextPrompt(selectedUniverseLabel);

    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // Fallback for environments where Clipboard API is unavailable.
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }

    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 2000);
  };

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-parchment-600" />
        <h3 className="text-sm font-semibold text-parchment-900">Univers</h3>
      </div>

      {/* Universe select */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label className="label mb-0">Choisis l'univers de jeu</label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={openAddUniversePanel}
              className="btn-secondary px-2.5 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Ajouter
            </button>
            <button
              type="button"
              onClick={() => void loadUniverses()}
              className="btn-secondary px-2.5 py-1.5 text-xs"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingUniverses ? "animate-spin" : ""}`}
              />
              {isLoadingUniverses ? "Actualisation..." : "Rafraichir"}
            </button>
          </div>
        </div>
        <select
          value={selectedUniverse}
          onChange={(e) => handleUniverseChange(e.target.value)}
          className="input"
        >
          {universes.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      </div>

      {isAddUniverseOpen && (
        <div className="rounded-lg border border-parchment-200 bg-parchment-50/50 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-parchment-900">
              Ajouter un univers
            </h4>
            <button
              type="button"
              onClick={closeAddUniversePanel}
              disabled={isCreatingUniverse}
              className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
            >
              Annuler
            </button>
          </div>

          <div>
            <label className="label">Nom de l'univers</label>
            <input
              type="text"
              value={newUniverseLabel}
              onChange={(e) => setNewUniverseLabel(e.target.value)}
              className="input"
              placeholder="Ex: Vampire La Mascarade"
              disabled={isCreatingUniverse}
            />
          </div>

          <div>
            <label className="label">Pre-prompt / lore initial</label>
            <textarea
              value={newUniversePrompt}
              onChange={(e) => setNewUniversePrompt(e.target.value)}
              rows={8}
              className="textarea font-mono text-xs"
              placeholder="Colle ici le contexte complet de cet univers..."
              disabled={isCreatingUniverse}
            />
          </div>

          {createUniverseError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {createUniverseError}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleCreateUniverse()}
              disabled={isCreatingUniverse}
              className="btn-primary px-4 py-2 text-xs disabled:opacity-50"
            >
              {isCreatingUniverse ? "Creation..." : "Creer cet univers"}
            </button>
          </div>
        </div>
      )}

      {/* Expandable context editor */}
      <div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1 text-sm text-parchment-600 hover:text-parchment-800 transition-colors"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          />
          Editer le pre-prompt / lore
        </button>

        {isExpanded && (
          <div className="mt-3 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="label mb-0">
                  Contexte de l'univers (lore, terminologie...)
                </label>
                <button
                  type="button"
                  onClick={copyUniversePrompt}
                  className="btn-secondary px-2.5 py-1.5 text-xs"
                >
                  {promptCopied ? (
                    <CheckCheck className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {promptCopied ? "Prompt copie" : "Copier le prompt parfait"}
                </button>
              </div>
              <p className="mb-2 text-xs text-parchment-500">
                Copie un meta-prompt optimise pour faire generer un contexte
                d'univers robuste par un autre LLM.
              </p>
              <textarea
                value={universeContext}
                onChange={(e) => handleContextChange(e.target.value)}
                rows={8}
                className="textarea font-mono text-xs"
                placeholder="Le contexte sera injecté dans les prompts des agents..."
              />
            </div>

            <div>
              <label className="label">
                Historique des sessions précédentes
              </label>
              <textarea
                value={sessionHistory}
                onChange={(e) => handleSessionHistoryChange(e.target.value)}
                rows={4}
                className="textarea font-mono text-xs"
                placeholder="Résumés des sessions précédentes, éléments de contexte importants..."
              />
            </div>

            <div className="pt-2 border-t border-parchment-200">
              <p className="text-xs text-parchment-500 mb-2">
                Les joueurs/PJ listés dans le formulaire ci-dessous peuvent être enregistrés comme défaut pour cet univers. Ils seront rechargés automatiquement quand tu sélectionnes cet univers.
              </p>
              <button
                type="button"
                onClick={handleSaveDefaultPlayers}
                className="btn-secondary text-xs"
              >
                Enregistrer les joueurs actuels comme défaut pour cet univers
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
