import { Clock3, Eye, Trash2 } from "lucide-react";
import type { ReportSummary } from "../lib/api";

interface ReportHistoryPanelProps {
  history: ReportSummary[];
  activeReportId: string | null;
  onOpenReport: (reportId: string) => void;
  onDeleteReport: (reportId: string) => void;
  onClearHistory: () => void;
  openDisabled?: boolean;
  storageError?: string | null;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function formatPlayers(
  players: Array<{ playerName: string; characterName: string }>
): string {
  return players
    .filter((p) => p.playerName || p.characterName)
    .map((p) =>
      p.playerName && p.characterName
        ? `${p.playerName} (${p.characterName})`
        : p.playerName || p.characterName
    )
    .join(", ");
}

export default function ReportHistoryPanel({
  history,
  activeReportId,
  onOpenReport,
  onDeleteReport,
  onClearHistory,
  openDisabled = false,
  storageError = null,
}: ReportHistoryPanelProps) {
  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-parchment-600" />
          <h3 className="text-sm font-semibold text-parchment-900">
            Historique des comptes-rendus
          </h3>
        </div>
        {history.length > 0 && (
          <button
            type="button"
            onClick={onClearHistory}
            className="btn-secondary text-xs"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Tout supprimer
          </button>
        )}
      </div>

      {storageError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {storageError}
        </p>
      )}

      {history.length === 0 ? (
        <p className="text-xs text-parchment-500">
          Aucun compte-rendu enregistré pour le moment.
        </p>
      ) : (
        <div className="space-y-2">
          {history.map((item) => {
            const playersStr = formatPlayers(item.players);
            return (
              <div
                key={item.id}
                className={`rounded-lg border px-3 py-2.5 transition-colors ${
                  item.id === activeReportId
                    ? "border-parchment-500 bg-parchment-50"
                    : "border-parchment-200 bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-parchment-900">
                      {item.universeName} - {item.transcriptName}
                    </p>
                    <p className="text-xs text-parchment-500">
                      {formatDate(item.createdAt)}
                    </p>
                    {playersStr && (
                      <p className="mt-0.5 truncate text-xs text-parchment-500">
                        {playersStr}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenReport(item.id)}
                      disabled={openDisabled}
                      className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Ouvrir
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteReport(item.id)}
                      className="rounded-lg p-2 text-parchment-400 transition-colors hover:bg-red-50 hover:text-red-500"
                      aria-label="Supprimer ce compte-rendu"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
