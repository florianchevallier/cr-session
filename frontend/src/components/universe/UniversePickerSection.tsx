import { RefreshCw, Plus, Pencil, Trash2 } from "lucide-react";
import type { Universe } from "../../lib/api";

interface UniversePickerSectionProps {
  selectedUniverse: string;
  universes: Universe[];
  canManageCurrentUniverse: boolean;
  isDeletingUniverse: boolean;
  isLoadingUniverses: boolean;
  selectId: string;
  onUniverseChange: (id: string) => void;
  onAddUniverse: () => void;
  onRenameUniverse: () => void;
  onDeleteUniverse: () => void;
  onRefreshUniverses: () => void;
}

export function UniversePickerSection({
  selectedUniverse,
  universes,
  canManageCurrentUniverse,
  isDeletingUniverse,
  isLoadingUniverses,
  selectId,
  onUniverseChange,
  onAddUniverse,
  onRenameUniverse,
  onDeleteUniverse,
  onRefreshUniverses,
}: UniversePickerSectionProps) {
  return (
    <div>
      <label htmlFor={selectId} className="label">
        Univers de jeu
      </label>
      <div className="flex gap-2">
        <select
          id={selectId}
          value={selectedUniverse}
          onChange={(e) => onUniverseChange(e.target.value)}
          className="input min-w-0 flex-1 cursor-pointer"
        >
          {universes.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRefreshUniverses}
          disabled={isLoadingUniverses}
          className="icon-btn h-11 w-11 border border-line-strong bg-surface"
          aria-label={isLoadingUniverses ? "Actualisation des univers…" : "Recharger la liste des univers"}
          title="Recharger la liste des univers"
        >
          <RefreshCw className={`h-4 w-4 ${isLoadingUniverses ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        <button type="button" onClick={onAddUniverse} className="btn-ghost btn-sm -ml-3">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Nouvel univers
        </button>
        {canManageCurrentUniverse && (
          <>
            <button
              type="button"
              onClick={onRenameUniverse}
              disabled={isDeletingUniverse}
              className="btn-ghost btn-sm"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Renommer
            </button>
            <button
              type="button"
              onClick={onDeleteUniverse}
              disabled={isDeletingUniverse}
              className="btn-danger btn-sm"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {isDeletingUniverse ? "Suppression…" : "Supprimer"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
