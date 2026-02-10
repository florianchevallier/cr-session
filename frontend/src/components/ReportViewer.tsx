import ReactMarkdown from "react-markdown";
import { Download, Copy, CheckCheck } from "lucide-react";
import { useState } from "react";

interface ReportViewerProps {
  report: string;
}

export default function ReportViewer({ report }: ReportViewerProps) {
  const [copied, setCopied] = useState(false);

  const handleDownload = () => {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cr-session-${new Date().toISOString().split("T")[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-parchment-900">
          Compte-Rendu de Session
        </h2>
        <div className="flex gap-2">
          <button onClick={handleCopy} className="btn-secondary text-xs">
            {copied ? (
              <CheckCheck className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copié !" : "Copier"}
          </button>
          <button onClick={handleDownload} className="btn-primary text-xs">
            <Download className="h-3.5 w-3.5" />
            Télécharger .md
          </button>
        </div>
      </div>

      {/* Report content */}
      <div className="card p-8 prose-report">
        <ReactMarkdown>{report}</ReactMarkdown>
      </div>
    </div>
  );
}
