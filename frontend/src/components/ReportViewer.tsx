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
} from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";

interface ReportViewerProps {
  report: string;
  reportId?: string | null;
  onCorrection?: (
    selectedText: string,
    instruction: string
  ) => Promise<void>;
  isCorrecting?: boolean;
}

export default function ReportViewer({
  report,
  reportId,
  onCorrection,
  isCorrecting = false,
}: ReportViewerProps) {
  const [copied, setCopied] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [showCorrectionPanel, setShowCorrectionPanel] = useState(false);
  const [correctionInstruction, setCorrectionInstruction] = useState("");
  const [selectionPosition, setSelectionPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const prevIsCorrecting = useRef(false);
  const reportBeforeCorrection = useRef<string | null>(null);
  const reportContentRef = useRef<HTMLDivElement>(null);
  const correctionButtonRef = useRef<HTMLDivElement>(null);
  const correctionPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // ── Track correction state for success detection ─────────────────────────

  useEffect(() => {
    if (isCorrecting && !prevIsCorrecting.current) {
      // Correction just started — snapshot the current report
      reportBeforeCorrection.current = report;
    }
    if (prevIsCorrecting.current && !isCorrecting && showCorrectionPanel) {
      // Correction just finished — check if report actually changed
      const reportChanged = report !== reportBeforeCorrection.current;
      if (reportChanged) {
        setShowSuccess(true);
        const timer = setTimeout(() => {
          setShowSuccess(false);
          setShowCorrectionPanel(false);
          setCorrectionInstruction("");
          setSelectedText("");
        }, 1500);
        // Store cleanup ref for unmount
        return () => clearTimeout(timer);
      }
      // If report didn't change, it was an error — keep panel open
    }
    prevIsCorrecting.current = isCorrecting;
  }, [isCorrecting, report, showCorrectionPanel]);

  // ── Auto-scroll correction panel into view ─────────────────────────────────

  useEffect(() => {
    if (showCorrectionPanel && correctionPanelRef.current) {
      correctionPanelRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [showCorrectionPanel]);

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
    setShowSuccess(false);
  };

  const handleSubmitCorrection = async () => {
    if (
      !onCorrection ||
      !selectedText ||
      !correctionInstruction.trim()
    )
      return;
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
      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-parchment-900">
          Compte-Rendu de Session
        </h2>
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

      {/* Correction panel */}
      {showCorrectionPanel && (
        <div
          ref={correctionPanelRef}
          className={`card p-4 border-2 transition-colors duration-300 ${
            showSuccess
              ? "border-green-400 bg-green-50/80"
              : "border-amber-300 bg-amber-50/80"
          }`}
        >
          {showSuccess ? (
            <div className="flex items-center gap-3 py-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                <Check className="h-4 w-4 text-green-600" />
              </div>
              <p className="text-sm font-medium text-green-800">
                Correction appliquée avec succès
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Pencil className="h-4 w-4 text-amber-700" />
                  <h3 className="text-sm font-semibold text-amber-900">
                    Demande de correction
                  </h3>
                </div>
                <button
                  onClick={handleCloseCorrectionPanel}
                  className="p-1 rounded-md hover:bg-amber-200/60 text-amber-700"
                  disabled={isCorrecting}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mb-3">
                <p className="text-xs text-amber-700 mb-1">
                  Texte sélectionné :
                </p>
                <div className="bg-white/80 rounded-lg p-3 text-sm text-parchment-800 border border-amber-200 max-h-24 overflow-y-auto italic">
                  « {selectedText} »
                </div>
              </div>

              <div className="mb-3">
                <label
                  htmlFor="correction-instruction"
                  className="block text-xs text-amber-700 mb-1"
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
                  className="w-full rounded-lg border border-amber-200 bg-white/90 px-3 py-2 text-sm text-parchment-800 placeholder-parchment-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-300 resize-y"
                  rows={3}
                  disabled={isCorrecting}
                  autoFocus
                />
                <p className="mt-1 text-[11px] text-amber-500">
                  {navigator.platform.includes("Mac")
                    ? "⌘"
                    : "Ctrl"}
                  +Entrée pour envoyer
                </p>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleSubmitCorrection}
                  disabled={
                    !correctionInstruction.trim() || isCorrecting
                  }
                  className="btn-primary text-xs"
                >
                  {isCorrecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  {isCorrecting
                    ? "Correction en cours..."
                    : "Appliquer la correction"}
                </button>
              </div>
            </>
          )}
        </div>
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
