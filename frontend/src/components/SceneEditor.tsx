import { useState, useEffect, useRef } from "react";
import { Save, X, Loader2 } from "lucide-react";
import { SHORTCUT_KEY } from "../lib/format";

interface SceneEditorProps {
  sceneId: number;
  content: string;
  onSave: (sceneId: number, newContent: string) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}

export default function SceneEditor({
  sceneId,
  content,
  onSave,
  onCancel,
  isSaving,
}: SceneEditorProps) {
  const [editedContent, setEditedContent] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const unchanged = editedContent.trim() === content.trim();

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, []);

  const handleCancel = () => {
    if (!isSaving) onCancel();
  };

  const handleSave = async () => {
    if (unchanged) {
      onCancel();
      return;
    }
    await onSave(sceneId, editedContent.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && !isSaving) {
      handleCancel();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isSaving) {
      e.preventDefault();
      void handleSave();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditedContent(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  return (
    <div className="my-6 rounded-xl border border-accent/40 bg-accent-soft/50 p-3 font-sans animate-fade-in sm:p-4">
      <label htmlFor={`scene-editor-${sceneId}`} className="sr-only">
        Texte de la scène {sceneId}
      </label>
      <textarea
        id={`scene-editor-${sceneId}`}
        ref={textareaRef}
        value={editedContent}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        className="textarea resize-none border-line-field bg-surface font-serif text-lg leading-relaxed sm:text-lg"
        rows={10}
        disabled={isSaving}
      />

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {isSaving
            ? "Enregistrement et mise à jour des métadonnées…"
            : `${SHORTCUT_KEY}+Entrée pour enregistrer · Échap pour annuler`}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={handleCancel} disabled={isSaving} className="btn-secondary btn-sm">
            <X className="h-4 w-4" aria-hidden="true" />
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || unchanged}
            className="btn-primary btn-sm"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-4 w-4" aria-hidden="true" />
            )}
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
