import { useState } from "react";
import { BookMarked, ChevronRight, Trash2 } from "lucide-react";
import type { ReportSummary } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import Notice from "./ui/Notice";

interface ReportHistoryPanelProps {
  history: ReportSummary[];
  activeReportId: string | null;
  universeLabels: Record<string, string>;
  onOpenReport: (reportId: string) => void;
  onDeleteReport: (reportId: string) => void;
  onClearHistory: () => void;
  openDisabled?: boolean;
  storageError?: string | null;
}

const INITIAL_VISIBLE = 5;

function castLine(players: ReportSummary["players"]): string {
  return players
    .map((p) => p.characterName?.trim() || p.playerName?.trim())
    .filter(Boolean)
    .join(", ");
}

export default function ReportHistoryPanel({
  history,
  activeReportId,
  universeLabels,
  onOpenReport,
  onDeleteReport,
  onClearHistory,
  openDisabled = false,
  storageError = null,
}: ReportHistoryPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? history : history.slice(0, INITIAL_VISIBLE);
  const hidden = history.length - visible.length;

  return (
    <section aria-labelledby="history-title" className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="history-title" className="section-title flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-accent-ink" aria-hidden="true" />
          Historique
        </h2>
        {history.length > 0 && (
          <span className="text-sm text-ink-muted">{history.length}</span>
        )}
      </div>

      {storageError && (
        <Notice tone="warn" className="mt-3">
          {storageError}
        </Notice>
      )}

      {history.length === 0 ? (
        <div className="mt-3">
          <p className="text-sm text-ink-muted">Aucun compte-rendu pour l'instant.</p>
        </div>
      ) : (
        <>
          <ul className="mt-4 space-y-2">
            {visible.map((item) => {
              const isActive = item.id === activeReportId;
              const cast = castLine(item.players);
              const universe = universeLabels[item.universeName] ?? item.universeName;
              return (
                <li key={item.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpenReport(item.id)}
                    disabled={openDisabled}
                    aria-current={isActive ? "true" : undefined}
                    className={`flex w-full items-start gap-3 rounded-lg border py-3 pl-4 pr-14 text-left transition-colors duration-150 ${
                      isActive
                        ? "border-accent/50 bg-accent-soft/70"
                        : "border-line bg-surface hover:border-line-strong hover:bg-sunken"
                    } disabled:opacity-60`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">
                        {formatDateTime(item.createdAt)}
                      </span>
                      {cast && (
                        <span className="mt-0.5 block truncate text-sm text-ink">{cast}</span>
                      )}
                      <span className="mt-0.5 block truncate text-xs text-ink-muted">
                        {universe} · <span className="font-mono">{item.transcriptName}</span>
                      </span>
                    </span>
                    <ChevronRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle transition-transform duration-150 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{isActive ? " (ouverte)" : " — ouvrir"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Supprimer le compte-rendu du ${formatDate(item.createdAt)} ? Cette action est irréversible.`)) {
                        onDeleteReport(item.id);
                      }
                    }}
                    className="icon-btn-danger absolute right-2 top-2"
                    aria-label={`Supprimer le compte-rendu du ${formatDateTime(item.createdAt)}`}
                    title="Supprimer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {hidden > 0 || showAll ? (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="btn-ghost btn-sm -ml-3">
                {showAll ? "Réduire la liste" : `Voir les ${hidden} autres`}
              </button>
            ) : (
              <span />
            )}
            <button type="button" onClick={onClearHistory} className="btn-danger btn-sm -mr-3">
              Tout supprimer
            </button>
          </div>
        </>
      )}
    </section>
  );
}
