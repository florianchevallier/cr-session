import { useState, useEffect, useRef } from "react";
import { Edit3, Save, X, Loader2 } from "lucide-react";

interface SceneEditorProps {
  sceneId: number;
  title: string;
  content: string;
  onSave: (sceneId: number, newContent: string) => Promise<void>;
  isSaving: boolean;
}

export default function SceneEditor({
  sceneId,
  title,
  content,
  onSave,
  isSaving,
}: SceneEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(content);
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditedContent(content);
  }, [content]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      // Auto-resize textarea to fit content
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [isEditing]);

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditedContent(content);
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (editedContent.trim() === content.trim()) {
      setIsEditing(false);
      return;
    }

    await onSave(sceneId, editedContent.trim());
    setIsEditing(false);
    setShowSaveSuccess(true);
    setTimeout(() => setShowSaveSuccess(false), 2000);
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
    // Auto-resize
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  return (
    <div className="relative group scene-editor-container">
      {/* Edit button (appears on hover) */}
      {!isEditing && (
        <button
          onClick={handleEdit}
          className="absolute -top-2 -right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg bg-parchment-600 hover:bg-parchment-700 text-white p-2 shadow-lg flex items-center gap-1.5 text-xs font-medium"
          aria-label={`Éditer ${title}`}
        >
          <Edit3 className="h-3.5 w-3.5" />
          Éditer
        </button>
      )}

      {/* Save success indicator */}
      {showSaveSuccess && (
        <div className="absolute -top-2 -right-2 z-20 animate-fade-in rounded-lg bg-green-600 text-white px-3 py-1.5 shadow-lg flex items-center gap-1.5 text-xs font-medium">
          <Save className="h-3.5 w-3.5" />
          Sauvegardé !
        </div>
      )}

      {/* Preview mode */}
      {!isEditing && (
        <div className="card p-4 bg-white/60 border border-parchment-200 hover:border-parchment-300 transition-colors">
          <h4 className="text-sm font-bold text-parchment-900 mb-2 flex items-center gap-2">
            {title}
          </h4>
          <div className="text-sm text-parchment-700 leading-relaxed whitespace-pre-wrap font-serif">
            {content.length > 200 ? `${content.slice(0, 200)}...` : content}
          </div>
        </div>
      )}

      {/* Editor mode */}
      {isEditing && (
        <div className="border-2 border-amber-400 rounded-lg p-4 bg-amber-50/30 animate-scale-in">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Edit3 className="h-4 w-4 text-amber-700" />
              <span className="text-sm font-semibold text-amber-900">
                Édition : {title}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCancel}
                disabled={isSaving}
                className="btn-secondary text-xs py-1"
                aria-label="Annuler"
              >
                <X className="h-3.5 w-3.5" />
                Annuler
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || editedContent.trim() === content.trim()}
                className="btn-primary text-xs py-1"
                aria-label="Sauvegarder"
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

          <textarea
            ref={textareaRef}
            value={editedContent}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            className="w-full rounded-lg border border-amber-300 bg-white/90 px-3 py-2.5 text-sm text-parchment-800 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-300/50 resize-none font-serif leading-relaxed"
            rows={10}
            disabled={isSaving}
          />

          <p className="mt-2 text-[11px] text-amber-600">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Entrée pour
            sauvegarder • Échap pour annuler
          </p>
        </div>
      )}
    </div>
  );
}
