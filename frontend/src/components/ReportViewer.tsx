import ReactMarkdown from "react-markdown";
import {
  Download,
  Copy,
  CheckCheck,
  Pencil,
  X,
  Loader2,
  Send,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import SceneEditor from "./SceneEditor";
import { fetchScenes, updateScene, type SceneWithSummary } from "../lib/api";

interface ReportViewerProps {
  report: string;
  reportId?: string | null;
  onCorrection?: (
    selectedText: string,
    instruction: string
  ) => Promise<void>;
  isCorrecting?: boolean;
  onReportUpdate?: (newReport: string) => void;
}

export default function ReportViewer({
  report,
  reportId,
  onCorrection,
  isCorrecting = false,
  onReportUpdate,
}: ReportViewerProps) {
  const [copied, setCopied] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [showCorrectionPanel, setShowCorrectionPanel] = useState(false);
  const [correctionInstruction, setCorrectionInstruction] = useState("");
  const [selectionPosition, setSelectionPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastType, setToastType] = useState<"loading" | "success">("loading");
  const prevIsCorrecting = useRef(false);
  const reportBeforeCorrection = useRef<string | null>(null);
  const reportContentRef = useRef<HTMLDivElement>(null);
  const correctionButtonRef = useRef<HTMLDivElement>(null);
  const correctionPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scene editing state
  const [scenes, setScenes] = useState<SceneWithSummary[]>([]);
  const [editingSceneId, setEditingSceneId] = useState<number | null>(null);
  const [isSavingScene, setIsSavingScene] = useState(false);
  const [scenesExpanded, setScenesExpanded] = useState(true);

  // ── Load scenes when reportId is available ────────────────────────────────

  useEffect(() => {
    if (!reportId) {
      setScenes([]);
      return;
    }

    const loadScenes = async () => {
      try {
        const fetchedScenes = await fetchScenes(reportId);
        setScenes(fetchedScenes);
      } catch (error) {
        console.error("Failed to load scenes:", error);
      }
    };

    void loadScenes();
  }, [reportId]);

  // ── Scene editing handlers ─────────────────────────────────────────────────

  const handleSceneSave = async (sceneId: number, newContent: string) => {
    if (!reportId) return;

    setIsSavingScene(true);
    setEditingSceneId(sceneId);

    try {
      const result = await updateScene(reportId, sceneId, newContent);

      // Update local scenes state
      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === sceneId && scene.summary
            ? {
                ...scene,
                summary: { ...scene.summary, narrativeSummary: newContent },
              }
            : scene
        )
      );

      // Notify parent component of report update
      if (onReportUpdate) {
        onReportUpdate(result.reportMd);
      }

      setToastType("success");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    } catch (error) {
      console.error("Failed to save scene:", error);
      alert(
        error instanceof Error
          ? error.message
          : "Erreur lors de la sauvegarde de la scène."
      );
    } finally {
      setIsSavingScene(false);
      setEditingSceneId(null);
    }
  };

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

  // ── Text selection handling ────────────────────────────────────────────────

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (!onCorrection || isCorrecting || showCorrectionPanel) return;

      // Don't interfere if clicking the correction button itself
      if (
        correctionButtonRef.current?.contains(e.target as Node)
      ) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectedText("");
        setSelectionPosition(null);
        return;
      }

      const text = selection.toString().trim();
      if (text.length < 3) {
        setSelectedText("");
        setSelectionPosition(null);
        return;
      }

      // Check if selection is within the report content area
      const range = selection.getRangeAt(0);
      if (
        reportContentRef.current &&
        reportContentRef.current.contains(range.commonAncestorContainer)
      ) {
        const rect = range.getBoundingClientRect();
        const containerRect =
          reportContentRef.current.getBoundingClientRect();
        setSelectedText(text);
        setSelectionPosition({
          top: rect.top - containerRect.top + rect.height + 8,
          left:
            rect.left - containerRect.left + rect.width / 2,
        });
      }
    },
    [onCorrection, isCorrecting, showCorrectionPanel]
  );

  useEffect(() => {
    document.addEventListener("mouseup", handleMouseUp);
    return () =>
      document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  // ── CSS Highlight API for selected text ────────────────────────────────────

  useEffect(() => {
    const hasHighlightAPI =
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      typeof Highlight !== "undefined";

    if (
      !showCorrectionPanel ||
      !selectedText ||
      !reportContentRef.current ||
      !hasHighlightAPI
    ) {
      if (hasHighlightAPI) {
        CSS.highlights.delete("correction-target");
      }
      return;
    }

    const treeWalker = document.createTreeWalker(
      reportContentRef.current,
      NodeFilter.SHOW_TEXT
    );

    // Build concatenated text with node positions
    let fullText = "";
    const nodePositions: {
      node: Text;
      start: number;
      end: number;
    }[] = [];
    let currentNode = treeWalker.nextNode();
    while (currentNode) {
      const start = fullText.length;
      fullText += currentNode.textContent || "";
      nodePositions.push({
        node: currentNode as Text,
        start,
        end: fullText.length,
      });
      currentNode = treeWalker.nextNode();
    }

    const matchIndex = fullText.indexOf(selectedText);
    if (matchIndex === -1) {
      CSS.highlights.delete("correction-target");
      return;
    }

    const matchEnd = matchIndex + selectedText.length;
    const range = new Range();
    let rangeStartSet = false;

    for (const { node, start, end } of nodePositions) {
      if (end <= matchIndex) continue;
      if (start >= matchEnd) break;

      const nodeLen = node.textContent?.length || 0;
      if (!rangeStartSet) {
        range.setStart(
          node,
          Math.max(0, matchIndex - start)
        );
        rangeStartSet = true;
      }
      range.setEnd(
        node,
        Math.min(matchEnd - start, nodeLen)
      );
    }

    if (rangeStartSet) {
      const highlight = new Highlight(range);
      CSS.highlights.set("correction-target", highlight);
    }

    return () => {
      CSS.highlights.delete("correction-target");
    };
  }, [showCorrectionPanel, selectedText, report]);

  // ── Track correction state for toast notifications ────────────────────────

  useEffect(() => {
    if (isCorrecting && !prevIsCorrecting.current) {
      // Correction just started
      reportBeforeCorrection.current = report;
      setToastType("loading");
      setShowToast(true);
    }
    if (prevIsCorrecting.current && !isCorrecting) {
      // Correction just finished
      const reportChanged = report !== reportBeforeCorrection.current;
      if (reportChanged) {
        setToastType("success");
        const timer = setTimeout(() => {
          setShowToast(false);
        }, 3000);
        return () => clearTimeout(timer);
      } else {
        // If report didn't change, hide toast (error was shown elsewhere)
        setShowToast(false);
      }
    }
    prevIsCorrecting.current = isCorrecting;
  }, [isCorrecting, report]);

  // ── Auto-focus textarea when panel opens ───────────────────────────────────

  useEffect(() => {
    if (showCorrectionPanel && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [showCorrectionPanel]);

  // ── Close modal with Escape key ────────────────────────────────────────────

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showCorrectionPanel && !isCorrecting) {
        handleCloseCorrectionPanel();
      }
    };

    if (showCorrectionPanel) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [showCorrectionPanel, isCorrecting]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleOpenCorrectionPanel = () => {
    window.getSelection()?.removeAllRanges();
    setShowCorrectionPanel(true);
    setSelectionPosition(null);
  };

  const handleCloseCorrectionPanel = () => {
    setShowCorrectionPanel(false);
    setCorrectionInstruction("");
    setSelectedText("");
  };

  const handleSubmitCorrection = async () => {
    if (
      !onCorrection ||
      !selectedText ||
      !correctionInstruction.trim()
    )
      return;

    // Close modal immediately and show toast
    setShowCorrectionPanel(false);
    setCorrectionInstruction("");
    setSelectedText("");

    await onCorrection(selectedText, correctionInstruction.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !isCorrecting &&
      correctionInstruction.trim()
    ) {
      e.preventDefault();
      handleSubmitCorrection();
    }
  };

  return (
    <div className="space-y-4">
      {/* Toast notification (top right) */}
      {showToast && (
        <div className="fixed top-4 right-4 z-50 animate-slide-in">
          <div
            className={`card px-4 py-3 shadow-lg border-2 flex items-center gap-3 min-w-[280px] ${
              toastType === "success"
                ? "border-green-400 bg-green-50/95"
                : "border-amber-400 bg-amber-50/95"
            }`}
          >
            {toastType === "loading" ? (
              <>
                <Loader2 className="h-5 w-5 text-amber-600 animate-spin flex-shrink-0" />
                <span className="text-sm font-medium text-amber-900">
                  Correction en cours...
                </span>
              </>
            ) : (
              <>
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 flex-shrink-0">
                  <Check className="h-4 w-4 text-green-600" />
                </div>
                <span className="text-sm font-medium text-green-800">
                  {isSavingScene ? "Scène sauvegardée !" : "Correction appliquée !"}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-parchment-900">
            Compte-Rendu de Session
          </h2>
          {reportId && scenes.length > 0 && (
            <button
              onClick={() => setScenesExpanded(!scenesExpanded)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all"
            >
              <Pencil className="h-3.5 w-3.5" />
              Éditer les scènes ({scenes.filter((s) => s.type !== "meta" && s.type !== "pause").length})
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="btn-secondary text-xs"
          >
            {copied ? (
              <CheckCheck className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copié !" : "Copier"}
          </button>
          <button
            onClick={handleDownload}
            className="btn-primary text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Télécharger .md
          </button>
        </div>
      </div>

      {/* Scene editors (if reportId available) */}
      {reportId && scenes.length > 0 && scenesExpanded && (
        <div className="card border-2 border-amber-400 overflow-hidden bg-gradient-to-br from-amber-50 to-amber-100/50 animate-scale-in">
          <div className="bg-amber-600 text-white px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              <h3 className="text-sm font-bold">
                Édition des scènes narratives
              </h3>
            </div>
            <button
              onClick={() => setScenesExpanded(false)}
              className="p-1 hover:bg-amber-700 rounded transition-colors"
              aria-label="Fermer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <p className="text-sm text-amber-900 mb-4 bg-amber-100 p-3 rounded-lg border border-amber-200">
              <strong>💡 Mode édition :</strong> Cliquez sur "Éditer" pour modifier le contenu narratif d'une scène. Les modifications régénèrent automatiquement le rapport complet.
            </p>

            {scenes
              .filter((scene) => scene.type !== "meta" && scene.type !== "pause")
              .map((scene) => (
                <div key={scene.id} className="relative">
                  {scene.summary ? (
                    <SceneEditor
                      sceneId={scene.id}
                      title={scene.title}
                      content={scene.summary.narrativeSummary}
                      onSave={handleSceneSave}
                      isSaving={isSavingScene && editingSceneId === scene.id}
                    />
                  ) : (
                    <div className="card p-4 bg-parchment-100/50 border border-parchment-200">
                      <p className="text-sm text-parchment-600">
                        <strong>{scene.title}</strong> - Contenu non disponible
                      </p>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Correction modal (floating) */}
      {showCorrectionPanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 animate-fade-in"
            onClick={!isCorrecting ? handleCloseCorrectionPanel : undefined}
          />

          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div
              ref={correctionPanelRef}
              className="card w-full max-w-xl p-6 border-2 border-amber-300 bg-amber-50/95 backdrop-blur-md pointer-events-auto animate-scale-in shadow-2xl"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Pencil className="h-5 w-5 text-amber-700" />
                  <h3 className="text-base font-semibold text-amber-900">
                    Demande de correction
                  </h3>
                </div>
                <button
                  onClick={handleCloseCorrectionPanel}
                  className="p-1.5 rounded-md hover:bg-amber-200/60 text-amber-700 transition-colors"
                  aria-label="Fermer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mb-4">
                <p className="text-xs font-medium text-amber-700 mb-2">
                  Texte sélectionné :
                </p>
                <div className="bg-white/90 rounded-lg p-3 text-sm text-parchment-800 border border-amber-200 max-h-32 overflow-y-auto italic shadow-sm">
                  « {selectedText} »
                </div>
              </div>

              <div className="mb-4">
                <label
                  htmlFor="correction-instruction"
                  className="block text-xs font-medium text-amber-700 mb-2"
                >
                  Quelle correction apporter ?
                </label>
                <textarea
                  ref={textareaRef}
                  id="correction-instruction"
                  value={correctionInstruction}
                  onChange={(e) =>
                    setCorrectionInstruction(e.target.value)
                  }
                  onKeyDown={handleKeyDown}
                  placeholder="Ex: Ce n'est pas Yumi qui lance le sort mais Kael..."
                  className="w-full rounded-lg border border-amber-200 bg-white/90 px-3 py-2.5 text-sm text-parchment-800 placeholder-parchment-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/50 resize-y shadow-sm"
                  rows={4}
                />
                <p className="mt-2 text-[11px] text-amber-600">
                  {navigator.platform.includes("Mac")
                    ? "⌘"
                    : "Ctrl"}
                  +Entrée pour envoyer
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={handleCloseCorrectionPanel}
                  className="btn-secondary text-sm"
                >
                  Annuler
                </button>
                <button
                  onClick={handleSubmitCorrection}
                  disabled={!correctionInstruction.trim()}
                  className="btn-primary text-sm"
                >
                  <Send className="h-4 w-4" />
                  Appliquer
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Report content */}
      <div
        className={`card p-8 prose-report relative transition-all duration-300 ${
          isCorrecting ? "correction-in-progress" : ""
        }`}
        ref={reportContentRef}
      >
        <ReactMarkdown>{report}</ReactMarkdown>

        {/* Dimming overlay during correction */}
        {isCorrecting && (
          <div className="correction-overlay" />
        )}

        {/* Floating correction button */}
        {selectedText &&
          selectionPosition &&
          !showCorrectionPanel &&
          onCorrection && (
            <div
              ref={correctionButtonRef}
              className="absolute z-50"
              style={{
                top: `${selectionPosition.top}px`,
                left: `${selectionPosition.left}px`,
                transform: "translateX(-50%)",
              }}
            >
              <div className="correction-button-container">
                <div className="correction-button-arrow" />
                <button
                  onClick={handleOpenCorrectionPanel}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-amber-700 active:scale-95 transition-all"
                >
                  <Pencil className="h-3 w-3" />
                  Corriger
                </button>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
