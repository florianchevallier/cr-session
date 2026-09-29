import { useEffect, useState } from "react";
import { ChevronDown, CheckCheck, Copy, UserCheck } from "lucide-react";

interface UniverseContextSectionProps {
  isExpanded: boolean;
  promptCopied: boolean;
  universeContext: string;
  sessionHistory: string;
  contextInputId: string;
  historyInputId: string;
  onToggleExpanded: () => void;
  onCopyPrompt: () => void;
  onContextChange: (value: string) => void;
  onSessionHistoryChange: (value: string) => void;
  onSaveDefaultPlayers: () => void;
}

const PANEL_ID = "universe-context-panel";

export function UniverseContextSection({
  isExpanded,
  promptCopied,
  universeContext,
  sessionHistory,
  contextInputId,
  historyInputId,
  onToggleExpanded,
  onCopyPrompt,
  onContextChange,
  onSessionHistoryChange,
  onSaveDefaultPlayers,
}: UniverseContextSectionProps) {
  const [playersSaved, setPlayersSaved] = useState(false);

  useEffect(() => {
    if (!playersSaved) return;
    const timer = window.setTimeout(() => setPlayersSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [playersSaved]);

  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={PANEL_ID}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken"
      >
        <span>
          <span className="block text-sm font-semibold text-ink">
            Lore et historique de la campagne
          </span>
          <span className="block text-sm text-ink-muted">
            Contexte injecté dans l'analyse · facultatif
            {sessionHistory.trim() ? " · historique renseigné" : ""}
          </span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-ink-muted transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isExpanded && (
        <div id={PANEL_ID} className="space-y-5 border-t border-line px-4 pb-4 pt-4">
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={contextInputId} className="label mb-0">
                Contexte de l'univers
              </label>
              <button
                type="button"
                onClick={onCopyPrompt}
                className="btn-ghost btn-sm -mr-2"
                aria-live="polite"
              >
                {promptCopied ? (
                  <CheckCheck className="h-4 w-4 text-ok" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {promptCopied ? "Méta-prompt copié" : "Copier le méta-prompt"}
              </button>
            </div>
            <p className="hint mb-2">
              Lore, terminologie, factions… Le méta-prompt t'aide à faire rédiger ce contexte par un
              autre assistant.
            </p>
            <textarea
              id={contextInputId}
              value={universeContext}
              onChange={(e) => onContextChange(e.target.value)}
              rows={8}
              className="textarea font-mono text-sm sm:text-xs"
              placeholder="Le contexte sera injecté dans les prompts des agents…"
            />
          </div>

          <div>
            <label htmlFor={historyInputId} className="label">
              Historique des sessions précédentes
            </label>
            <textarea
              id={historyInputId}
              value={sessionHistory}
              onChange={(e) => onSessionHistoryChange(e.target.value)}
              rows={4}
              className="textarea text-sm"
              placeholder="Résumés des sessions précédentes, éléments importants à garder en tête…"
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="hint max-w-md">
              Enregistre la table actuelle pour la recharger à chaque fois que tu choisis cet univers.
            </p>
            <button
              type="button"
              onClick={() => {
                onSaveDefaultPlayers();
                setPlayersSaved(true);
              }}
              className="btn-secondary btn-sm shrink-0 self-start sm:self-auto"
              aria-live="polite"
            >
              {playersSaved ? (
                <CheckCheck className="h-4 w-4 text-ok" aria-hidden="true" />
              ) : (
                <UserCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {playersSaved ? "Joueurs mémorisés" : "Mémoriser les joueurs"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
