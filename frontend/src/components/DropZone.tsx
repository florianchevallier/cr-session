import { useCallback, useId, useRef, useState } from "react";
import { FileText, FileAudio, Upload, X, RefreshCw } from "lucide-react";
import { formatFileSize } from "../lib/format";
import { isAudioFile } from "../lib/api";

interface DropZoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
}

function isTranscriptFile(file: File): boolean {
  return (
    file.type === "text/plain" ||
    file.type === "application/json" ||
    /\.(txt|text|json)$/i.test(file.name)
  );
}

export default function DropZone({ file, onFileChange }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();

  const accept = useCallback(
    (candidate: File | undefined) => {
      if (!candidate) return;
      if (!isTranscriptFile(candidate) && !isAudioFile(candidate)) {
        setError(
          `« ${candidate.name} » n'est ni un enregistrement audio ni un transcript. Formats acceptés : audio (.m4a, .mp3, .aac, .wav, .ogg…), .txt ou .json WhisperX.`
        );
        return;
      }
      setError(null);
      onFileChange(candidate);
    },
    [onFileChange]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      accept(e.dataTransfer.files[0]);
    },
    [accept]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    accept(e.target.files?.[0]);
    // Allow re-selecting the same file after removing it.
    e.target.value = "";
  };

  const input = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      accept=".txt,.text,.json,text/plain,application/json,audio/*,.aac,.m4a,.mp3,.wav,.ogg,.opus,.flac,.webm"
      onChange={handleInputChange}
      aria-describedby={hintId}
      // Once a file is chosen, the visible "Changer" button drives this input.
      tabIndex={file ? -1 : undefined}
      aria-hidden={file ? true : undefined}
      className="sr-only"
    />
  );

  if (file) {
    const audio = isAudioFile(file);
    const FileIcon = audio ? FileAudio : FileText;
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line-strong bg-sunken px-4 py-3">
        {input}
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface text-accent-ink">
          <FileIcon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{file.name}</p>
          <p id={hintId} className="text-sm text-ink-muted">
            {formatFileSize(file.size)} ·{" "}
            {audio ? "enregistrement : transcrit puis écouté pendant l'analyse" : "transcript prêt à être lu"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="btn-ghost btn-sm hidden sm:inline-flex"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Changer
        </button>
        <button
          type="button"
          onClick={() => onFileChange(null)}
          className="icon-btn-danger"
          aria-label={`Retirer ${file.name}`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragging(false)}
        className={`group flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors duration-150 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${
          isDragging
            ? "border-accent bg-accent-soft"
            : "border-line-field bg-surface hover:border-accent hover:bg-sunken"
        }`}
      >
        {input}
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors duration-150 ${
            isDragging ? "bg-surface text-accent-ink" : "bg-sunken text-accent-ink group-hover:bg-surface"
          }`}
        >
          <Upload className="h-6 w-6" aria-hidden="true" />
        </span>
        <span className="text-base font-semibold text-ink">
          {isDragging ? "Lâche le fichier ici" : "Dépose l'enregistrement ou le transcript de ta session"}
        </span>
        <span id={hintId} className="text-sm text-ink-muted">
          ou <span className="font-medium text-accent-ink underline underline-offset-2">choisis un fichier</span> · audio recommandé (.m4a, .mp3…), ou .txt / .json
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
