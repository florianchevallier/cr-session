import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  Download,
  Copy,
  CheckCheck,
  Pencil,
  X,
  Loader2,
  Send,
  Check,
  RefreshCw,
} from "lucide-react";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import SceneEditor from "./SceneEditor";
import SceneBar from "./SceneBar";
import { fetchScenes, updateScene, regenerateScene, rebuildReport, type SceneWithSummary } from "../lib/api";

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

function getTextContent(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as React.ReactElement<{ children?: React.ReactNode }>;
    return getTextContent(el.props.children);
  }
  return "";
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
  const [correctingText, setCorrectingText] = useState("");
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
  const [regeneratingSceneId, setRegeneratingSceneId] = useState<number | null>(null);
  const [regeneratePromptSceneId, setRegeneratePromptSceneId] = useState<number | null>(null);
  const [regenerateInstruction, setRegenerateInstruction] = useState("");
  const regenerateTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState<number | null>(null);
  const [renderedSceneIds, setRenderedSceneIds] = useState<number[]>([]);

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

    try {
      const result = await updateScene(reportId, sceneId, newContent);

      if (result.updatedSummary) {
        setScenes((prev) =>
          prev.map((scene) =>
            scene.id === sceneId
              ? { ...scene, summary: result.updatedSummary! }
              : scene
          )
        );
      } else {
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
      }

      if (onReportUpdate) {
        onReportUpdate(result.reportMd);
      }

      setEditingSceneId(null);
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
    }
  };

  const handleScrollToScene = useCallback((sceneId: number) => {
    if (!reportContentRef.current) return;
    const heading = reportContentRef.current.querySelector<HTMLElement>(
      `h2[data-scene-id="${sceneId}"]`
    );
    if (!heading) return;

    setActiveSceneId(sceneId);
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
    heading.classList.add("highlight-flash");
    setTimeout(() => heading.classList.remove("highlight-flash"), 2000);
  }, []);

  const handleRegenerateScene = useCallback((sceneId: number) => {
    if (!reportId || regeneratingSceneId !== null) return;
    setRegeneratePromptSceneId(sceneId);
    setRegenerateInstruction("");
  }, [reportId, regeneratingSceneId]);

  const handleConfirmRegenerate = useCallback(async () => {
    if (!reportId || regeneratePromptSceneId === null || regeneratingSceneId !== null) return;

    const sceneId = regeneratePromptSceneId;
    const instruction = regenerateInstruction.trim();
    setRegeneratePromptSceneId(null);
    setRegenerateInstruction("");
    setRegeneratingSceneId(sceneId);
    setToastType("loading");
    setShowToast(true);

    try {
      const result = await regenerateScene(reportId, sceneId, instruction || undefined);

      if (onReportUpdate) {
        onReportUpdate(result.reportMd);
      }

      setScenes((prev) =>
        prev.map((scene) =>
          scene.id === sceneId
            ? { ...scene, summary: result.regeneratedSummary }
            : scene
        )
      );

      setToastType("success");
      setTimeout(() => setShowToast(false), 3000);
    } catch (error) {
      console.error("Failed to regenerate scene:", error);
      setShowToast(false);
      alert(
        error instanceof Error
          ? error.message
          : "Erreur lors de la régénération de la scène."
      );
    } finally {
      setRegeneratingSceneId(null);
    }
  }, [reportId, regeneratePromptSceneId, regenerateInstruction, regeneratingSceneId, onReportUpdate]);

  const handleRebuild = useCallback(async () => {
    if (!reportId || isRebuilding) return;
    setIsRebuilding(true);
    setToastType("loading");
    setShowToast(true);

    try {
      const result = await rebuildReport(reportId);

      if (onReportUpdate) {
        onReportUpdate(result.reportMd);
      }

      setToastType("success");
      setTimeout(() => setShowToast(false), 3000);
    } catch (error) {
      console.error("Failed to rebuild report:", error);
      setShowToast(false);
      alert(
        error instanceof Error
          ? error.message
          : "Erreur lors de la reconstruction du rapport."
      );
    } finally {
      setIsRebuilding(false);
    }
  }, [reportId, isRebuilding, onReportUpdate]);

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

  // ── CSS Highlight API for selected/correcting text ─────────────────────────

  useEffect(() => {
    const hasHighlightAPI =
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      typeof Highlight !== "undefined";

    const textToHighlight =
      (showCorrectionPanel && selectedText) || correctingText || null;

    if (!textToHighlight || !reportContentRef.current || !hasHighlightAPI) {
      if (hasHighlightAPI) {
        CSS.highlights.delete("correction-target");
      }
      return;
    }

    const treeWalker = document.createTreeWalker(
      reportContentRef.current,
      NodeFilter.SHOW_TEXT
    );

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

    const matchIndex = fullText.indexOf(textToHighlight);
    if (matchIndex === -1) {
      CSS.highlights.delete("correction-target");
      return;
    }

    const matchEnd = matchIndex + textToHighlight.length;
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
  }, [showCorrectionPanel, selectedText, correctingText, report]);

  // ── Track correction state for toast notifications ────────────────────────

  useEffect(() => {
    if (isCorrecting && !prevIsCorrecting.current) {
      reportBeforeCorrection.current = report;
      setToastType("loading");
      setShowToast(true);
    }
    if (prevIsCorrecting.current && !isCorrecting) {
      const reportChanged = report !== reportBeforeCorrection.current;
      if (reportChanged) {
        setToastType("success");
        const timer = setTimeout(() => {
          setShowToast(false);
        }, 3000);
        return () => clearTimeout(timer);
      } else {
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

  useEffect(() => {
    if (regeneratePromptSceneId !== null && regenerateTextareaRef.current) {
      regenerateTextareaRef.current.focus();
    }
  }, [regeneratePromptSceneId]);

  // ── Close modals with Escape key ───────────────────────────────────────────

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (regeneratePromptSceneId !== null) {
          setRegeneratePromptSceneId(null);
          setRegenerateInstruction("");
        } else if (showCorrectionPanel && !isCorrecting) {
          handleCloseCorrectionPanel();
        } else if (editingSceneId && !isSavingScene) {
          setEditingSceneId(null);
        }
      }
    };

    if (showCorrectionPanel || editingSceneId || regeneratePromptSceneId !== null) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [showCorrectionPanel, isCorrecting, editingSceneId, isSavingScene, regeneratePromptSceneId]);

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

    const textToCorrect = selectedText;
    const instruction = correctionInstruction.trim();

    setShowCorrectionPanel(false);
    setCorrectionInstruction("");
    setSelectedText("");
    setCorrectingText(textToCorrect);

    await onCorrection(textToCorrect, instruction);
    setCorrectingText("");
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

  // ── Custom ReactMarkdown components for scene edit buttons ─────────────────

  const narrativeScenes = useMemo(
    () => scenes.filter((s) => s.type !== "meta" && s.type !== "pause"),
    [scenes]
  );

  useEffect(() => {
    if (narrativeScenes.length === 0) {
      setActiveSceneId(null);
      setRenderedSceneIds([]);
      return;
    }
  }, [narrativeScenes]);

  useEffect(() => {
    if (!reportContentRef.current) {
      setRenderedSceneIds([]);
      return;
    }

    const ids = Array.from(
      reportContentRef.current.querySelectorAll<HTMLElement>("h2[data-scene-id]")
    )
      .map((heading) => Number(heading.dataset.sceneId))
      .filter((id): id is number => !Number.isNaN(id));

    const uniqueIds = Array.from(new Set(ids));
    setRenderedSceneIds((prev) => {
      if (
        prev.length === uniqueIds.length &&
        prev.every((id, idx) => id === uniqueIds[idx])
      ) {
        return prev;
      }
      return uniqueIds;
    });
  }, [report, narrativeScenes, editingSceneId]);

  useEffect(() => {
    if (renderedSceneIds.length === 0) {
      setActiveSceneId(null);
      return;
    }

    setActiveSceneId((prev) =>
      prev !== null && renderedSceneIds.includes(prev)
        ? prev
        : renderedSceneIds[0]
    );
  }, [renderedSceneIds]);

  useEffect(() => {
    if (!reportContentRef.current || narrativeScenes.length === 0) return;

    const headings = Array.from(
      reportContentRef.current.querySelectorAll<HTMLElement>("h2[data-scene-id]")
    );
    if (headings.length === 0) return;

    let ticking = false;

    const updateActiveScene = () => {
      ticking = false;
      const threshold = 140;
      let nextSceneId: number | null = null;

      for (const heading of headings) {
        const sceneId = Number(heading.dataset.sceneId);
        if (Number.isNaN(sceneId)) continue;

        if (heading.getBoundingClientRect().top - threshold <= 0) {
          nextSceneId = sceneId;
        } else {
          break;
        }
      }

      if (nextSceneId === null) {
        const firstSceneId = Number(headings[0].dataset.sceneId);
        nextSceneId = Number.isNaN(firstSceneId) ? null : firstSceneId;
      }

      if (nextSceneId !== null) {
        setActiveSceneId((prev) => (prev === nextSceneId ? prev : nextSceneId));
      }
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateActiveScene);
    };

    updateActiveScene();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [report, narrativeScenes]);

  const editingScene = editingSceneId
    ? scenes.find((s) => s.id === editingSceneId)
    : null;

  const inlineEditRef = useRef({
    editingScene: editingScene,
    onSave: handleSceneSave,
    onCancel: () => setEditingSceneId(null),
    isSaving: isSavingScene,
  });
  inlineEditRef.current = {
    editingScene,
    onSave: handleSceneSave,
    onCancel: () => setEditingSceneId(null),
    isSaving: isSavingScene,
  };

  const markdownComponents = useMemo<Components>(() => {
    const renderState = { suppress: false };

    return {
      h2: ({ children, ...props }) => {
        renderState.suppress = false;

        const headingText = getTextContent(children).trim();
        const scene = narrativeScenes.find((s) => s.title === headingText);

        if (!scene) {
          return <h2 {...props}>{children}</h2>;
        }

        const baseClassName = typeof props.className === "string" ? props.className : "";
        const headingClassName = [
          baseClassName,
          "scroll-mt-28",
          reportId && !editingSceneId ? "group/heading" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (editingSceneId === scene.id) {
          renderState.suppress = true;
          const { editingScene: es, onSave, onCancel, isSaving } = inlineEditRef.current;

          return (
            <>
              <h2
                {...props}
                id={`scene-${scene.id}`}
                data-scene-id={scene.id}
                className={[baseClassName, "scroll-mt-28"].filter(Boolean).join(" ")}
              >
                {children}
              </h2>
              {es?.summary && (
                <SceneEditor
                  sceneId={scene.id}
                  content={es.summary.narrativeSummary}
                  onSave={onSave}
                  onCancel={onCancel}
                  isSaving={isSaving}
                />
              )}
            </>
          );
        }

        if (!reportId || editingSceneId) {
          return (
            <h2
              {...props}
              id={`scene-${scene.id}`}
              data-scene-id={scene.id}
              className={headingClassName}
            >
              {children}
            </h2>
          );
        }

        return (
          <h2
            {...props}
            id={`scene-${scene.id}`}
            data-scene-id={scene.id}
            className={headingClassName}
            style={{ position: "relative" }}
          >
            {children}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingSceneId(scene.id);
              }}
              className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/heading:opacity-100 transition-all duration-200 rounded-lg bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1.5 shadow-lg flex items-center gap-1.5 text-xs font-medium"
              aria-label={`Éditer ${scene.title}`}
            >
              <Pencil className="h-3 w-3" />
              Éditer
            </button>
          </h2>
        );
      },
      p: ({ children, ...props }) => {
        if (renderState.suppress) return null;
        return <p {...props}>{children}</p>;
      },
      blockquote: ({ children, ...props }) => {
        if (renderState.suppress) return null;
        return <blockquote {...props}>{children}</blockquote>;
      },
      ul: ({ children, ...props }) => {
        if (renderState.suppress) return null;
        return <ul {...props}>{children}</ul>;
      },
      ol: ({ children, ...props }) => {
        if (renderState.suppress) return null;
        return <ol {...props}>{children}</ol>;
      },
      hr: (props) => {
        renderState.suppress = false;
        return <hr {...props} />;
      },
    };
  }, [narrativeScenes, reportId, editingSceneId]);

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
                  {isRebuilding
                    ? "Reconstruction du rapport..."
                    : regeneratingSceneId !== null
                      ? "Régénération de la scène en cours..."
                      : isSavingScene
                        ? "Sauvegarde et mise à jour des métadonnées..."
                        : "Correction en cours..."}
                </span>
              </>
            ) : (
              <>
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 flex-shrink-0">
                  <Check className="h-4 w-4 text-green-600" />
                </div>
                <span className="text-sm font-medium text-green-800">
                  {isRebuilding
                    ? "Rapport reconstruit !"
                    : regeneratingSceneId !== null
                      ? "Scène régénérée !"
                      : isSavingScene
                        ? "Scène sauvegardée !"
                        : "Correction appliquée !"}
                </span>
              </>
            )}
          </div>
        </div>
      )}

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

      {/* Correction modal */}
      {showCorrectionPanel && (
        <>
          <div
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 animate-fade-in"
            onClick={!isCorrecting ? handleCloseCorrectionPanel : undefined}
          />

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

      {/* Regeneration instruction modal */}
      {regeneratePromptSceneId !== null && (() => {
        const promptScene = scenes.find((s) => s.id === regeneratePromptSceneId);
        return (
          <>
            <div
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 animate-fade-in"
              onClick={() => { setRegeneratePromptSceneId(null); setRegenerateInstruction(""); }}
            />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
              <div className="card w-full max-w-xl p-6 border-2 border-amber-300 bg-amber-50/95 backdrop-blur-md pointer-events-auto animate-scale-in shadow-2xl">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-5 w-5 text-amber-700" />
                    <h3 className="text-base font-semibold text-amber-900">
                      Régénérer la scène
                    </h3>
                  </div>
                  <button
                    onClick={() => { setRegeneratePromptSceneId(null); setRegenerateInstruction(""); }}
                    className="p-1.5 rounded-md hover:bg-amber-200/60 text-amber-700 transition-colors"
                    aria-label="Fermer"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {promptScene && (
                  <div className="mb-4">
                    <div className="bg-white/90 rounded-lg px-3 py-2 text-sm text-parchment-800 border border-amber-200 shadow-sm">
                      <span className="font-semibold">Scène {promptScene.id}</span>
                      <span className="mx-1.5 text-parchment-400">·</span>
                      <span>{promptScene.title}</span>
                    </div>
                  </div>
                )}

                <div className="mb-4">
                  <label
                    htmlFor="regenerate-instruction"
                    className="block text-xs font-medium text-amber-700 mb-2"
                  >
                    Que souhaitez-vous changer ou améliorer ?
                  </label>
                  <textarea
                    ref={regenerateTextareaRef}
                    id="regenerate-instruction"
                    value={regenerateInstruction}
                    onChange={(e) => setRegenerateInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleConfirmRegenerate();
                      }
                    }}
                    placeholder="Ex: Le MJ ne devrait pas apparaître dans le récit, c'est Stan qui explique ce point, pas le MJ..."
                    className="w-full rounded-lg border border-amber-200 bg-white/90 px-3 py-2.5 text-sm text-parchment-800 placeholder-parchment-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-300/50 resize-y shadow-sm"
                    rows={3}
                  />
                  <p className="mt-2 text-[11px] text-amber-600">
                    {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Entrée pour régénérer · Laissez vide pour une simple régénération
                  </p>
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => { setRegeneratePromptSceneId(null); setRegenerateInstruction(""); }}
                    className="btn-secondary text-sm"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={() => void handleConfirmRegenerate()}
                    className="btn-primary text-sm"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Régénérer
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      })()}

      <div
        className={
          scenes.length > 0
            ? "space-y-4 lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start lg:gap-5 lg:space-y-0"
            : ""
        }
      >
        {/* Scene navigation bar */}
        {scenes.length > 0 && (
          <aside className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]">
            <SceneBar
              scenes={scenes}
              renderedSceneIds={renderedSceneIds}
              onScrollToScene={handleScrollToScene}
              onRegenerate={handleRegenerateScene}
              onRebuild={handleRebuild}
              regeneratingSceneId={regeneratingSceneId}
              isRebuilding={isRebuilding}
              activeSceneId={activeSceneId}
            />
          </aside>
        )}

        {/* Report content */}
        <div
          className="card p-8 prose-report relative"
          ref={reportContentRef}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {report}
          </ReactMarkdown>

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
    </div>
  );
}
