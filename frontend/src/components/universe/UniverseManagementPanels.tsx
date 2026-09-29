import { useEffect, useState } from "react";
import Notice from "../ui/Notice";

const ADD_UNIVERSE_LABEL_ID = "add-universe-label";
const ADD_UNIVERSE_PROMPT_ID = "add-universe-prompt";
const RENAME_UNIVERSE_LABEL_ID = "rename-universe-label";

interface AddUniversePanelProps {
  onCreate: (input: { label: string; prompt: string }) => Promise<void>;
  onCancel: () => void;
}

export function AddUniversePanel({ onCreate, onCancel }: AddUniversePanelProps) {
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmedLabel = label.trim();
    const trimmedPrompt = prompt.trim();

    if (!trimmedLabel) {
      setError("Le nom de l'univers est obligatoire.");
      return;
    }

    if (!trimmedPrompt) {
      setError("Le contexte (lore) de l'univers est obligatoire.");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onCreate({ label: trimmedLabel, prompt: trimmedPrompt });
      setLabel("");
      setPrompt("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de créer le nouvel univers."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-line-strong bg-sunken p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          Nouvel univers
        </h3>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="btn-ghost btn-sm -mr-2"
        >
          Annuler
        </button>
      </div>

      <div>
        <label htmlFor={ADD_UNIVERSE_LABEL_ID} className="label">
          Nom de l'univers
        </label>
        <input
          id={ADD_UNIVERSE_LABEL_ID}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="input"
          placeholder="Ex. : Vampire : la Mascarade"
          disabled={isSubmitting}
        />
      </div>

      <div>
        <label htmlFor={ADD_UNIVERSE_PROMPT_ID} className="label">
          Contexte de l'univers (lore)
        </label>
        <textarea
          id={ADD_UNIVERSE_PROMPT_ID}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          className="textarea font-mono text-sm sm:text-xs"
          placeholder="Colle ici le contexte complet de cet univers…"
          disabled={isSubmitting}
        />
      </div>

      {error && (
        <Notice tone="danger">{error}</Notice>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isSubmitting}
          className="btn-primary btn-sm"
        >
          {isSubmitting ? "Création…" : "Créer cet univers"}
        </button>
      </div>
    </div>
  );
}

interface RenameUniversePanelProps {
  initialLabel: string;
  onRename: (label: string) => Promise<void>;
  onCancel: () => void;
}

export function RenameUniversePanel({
  initialLabel,
  onRename,
  onCancel,
}: RenameUniversePanelProps) {
  const [label, setLabel] = useState(initialLabel);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(initialLabel);
    setError(null);
  }, [initialLabel]);

  const handleRename = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Le nom de l'univers est obligatoire.");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onRename(trimmedLabel);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de renommer cet univers."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-line-strong bg-sunken p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          Renommer l'univers
        </h3>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="btn-ghost btn-sm -mr-2"
        >
          Annuler
        </button>
      </div>

      <div>
        <label htmlFor={RENAME_UNIVERSE_LABEL_ID} className="label">
          Nouveau nom
        </label>
        <input
          id={RENAME_UNIVERSE_LABEL_ID}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="input"
          placeholder="Ex. : Vampire : la Mascarade"
          disabled={isSubmitting}
        />
      </div>

      {error && (
        <Notice tone="danger">{error}</Notice>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleRename()}
          disabled={isSubmitting}
          className="btn-primary btn-sm"
        >
          {isSubmitting ? "Renommage…" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}
