import { useCallback, useState, useRef } from "react";
import { Upload, FileText, X } from "lucide-react";

interface DropZoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
}

export default function DropZone({ file, onFileChange }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const dropped = e.dataTransfer.files[0];
      if (dropped && dropped.type === "text/plain") {
        onFileChange(dropped);
      }
    },
    [onFileChange]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) onFileChange(selected);
  };

  if (file) {
    return (
      <div className="card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-parchment-100 p-2.5">
              <FileText className="h-5 w-5 text-parchment-700" />
            </div>
            <div>
              <p className="text-sm font-semibold text-parchment-900">
                {file.name}
              </p>
              <p className="text-xs text-parchment-500">
                {(file.size / 1024).toFixed(1)} Ko
              </p>
            </div>
          </div>
          <button
            onClick={() => onFileChange(null)}
            className="rounded-lg p-1.5 text-parchment-400 transition-colors hover:bg-parchment-100 hover:text-parchment-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
      className={`card cursor-pointer border-2 border-dashed p-12 text-center transition-all ${
        isDragging
          ? "border-parchment-500 bg-parchment-50"
          : "border-parchment-300 hover:border-parchment-400 hover:bg-parchment-50/50"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.text"
        onChange={handleInputChange}
        className="hidden"
      />
      <Upload
        className={`mx-auto mb-4 h-10 w-10 ${
          isDragging ? "text-parchment-600" : "text-parchment-400"
        }`}
      />
      <p className="text-sm font-medium text-parchment-700">
        Glisse ton fichier transcript ici
      </p>
      <p className="mt-1 text-xs text-parchment-400">
        ou clique pour parcourir (.txt)
      </p>
    </div>
  );
}
