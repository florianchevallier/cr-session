import { useState, useEffect, useRef } from "react";
import { Save, X, Loader2 } from "lucide-react";

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
    if (editedContent.trim() === content.trim()) {
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
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50/30 p-4 my-4 animate-fade-in">
      <textarea
        ref={textareaRef}
        value={editedContent}
        onChange={handleTextareaChange}
        onKeyDown={handleKeyDown}
        className="w-full rounded-lg border border-amber-300 bg-white/90 px-3 py-2.5 text-sm text-parchment-800 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-300/50 resize-none font-serif leading-relaxed"
        rows={10}
        disabled={isSaving}
      />

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] text-amber-600">
          {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Entrée pour
          sauvegarder · Échap pour annuler
          {isSaving && " · Mise à jour des métadonnées en cours..."}
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleCancel}
            disabled={isSaving}
            className="btn-secondary text-xs py-1"
          >
            <X className="h-3.5 w-3.5" />
            Annuler
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || editedContent.trim() === content.trim()}
            className="btn-primary text-xs py-1"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Sauvegarder
          </button>
        </div>
      </div>
    </div>
  );
}
