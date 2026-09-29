import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  Download,
  Copy,
  CheckCheck,
  Pencil,
  Loader2,
  Send,
  Check,
  RefreshCw,
  MapPin,
  Dices,
  Users,
  NotebookPen,
  Plus,
  ArrowUp,
  OctagonAlert,
} from "lucide-react";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import SceneEditor from "./SceneEditor";
import SceneBar, { SCENE_TYPES } from "./SceneBar";
import Modal from "./ui/Modal";
import { fetchScenes, updateScene, regenerateScene, rebuildReport, type SceneWithSummary } from "../lib/api";
import { formatDate, prefersReducedMotion, SHORTCUT_KEY } from "../lib/format";

export interface ReportMeta {
  universeLabel?: string;
  createdAt?: string;
  transcriptName?: string;
  /** Coût Gemini de la génération, en dollars (absent pour les anciens rapports). */
  costUsd?: number | null;
}

interface ReportViewerProps {
  report: string;
  reportId?: string | null;
  meta?: ReportMeta;
  onCorrection?: (
    selectedText: string,
    instruction: string
  ) => Promise<void>;
  isCorrecting?: boolean;
  onReportUpdate?: (newReport: string) => void;
  onNewSession?: () => void;
}

type Toast = { type: "loading" | "success" | "error"; message: string } | null;

const REMARK_PLUGINS = [remarkGfm];

// Leading pictograms produced by the formatter, mapped to one icon family.
const LABEL_ICONS: Array<[RegExp, typeof Dices]> = [
  [/^🎲/u, Dices],
  [/^👥/u, Users],
  [/^📝/u, NotebookPen],
  [/^📍/u, MapPin],
];
const LEADING_EMOJI = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})️?\s*/u;

function getTextContent(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as React.ReactElement<{ children?: ReactNode }>;
    return getTextContent(el.props.children);
  }
  return "";
}

/** Replace a leading emoji in the first text child with a proper icon. */
function withIcon(children: ReactNode): { icon: typeof Dices | null; children: ReactNode } {
  const list = Array.isArray(children) ? [...children] : [children];
  const first = list[0];
  if (typeof first !== "string" || !LEADING_EMOJI.test(first)) return { icon: null, children };
  const icon = LABEL_ICONS.find(([re]) => re.test(first))?.[1] ?? null;
  list[0] = first.replace(LEADING_EMOJI, "");
  return { icon, children: list };
}

function parseTitle(report: string, universeLabel?: string): { raw: string | null; display: string } {
  const match = report.match(/^#\s+(.+)$/m);
  const raw = match ? match[1].trim() : null;
  if (!raw) return { raw, display: universeLabel ?? "Compte-rendu de session" };
  const rest = raw.replace(/^compte[- ]rendu de session\s*[:—–-]?\s*/i, "").trim();
  if (!rest) return { raw, display: universeLabel ?? raw };
  if (universeLabel && universeLabel.toLowerCase().startsWith(rest.toLowerCase())) {
    return { raw, display: universeLabel };
  }
  return { raw, display: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

export default function ReportViewer({
  report,
  reportId,
  meta,
  onCorrection,
  isCorrecting = false,
  onReportUpdate,
  onNewSession,
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
  const [toast, setToast] = useState<Toast>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const prevIsCorrecting = useRef(false);
  const reportBeforeCorrection = useRef<string | null>(null);
  const reportContentRef = useRef<HTMLDivElement>(null);
  const correctionButtonRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number | null>(null);

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

  const title = useMemo(() => parseTitle(report, meta?.universeLabel), [report, meta?.universeLabel]);

  const notify = useCallback((next: Toast, autoHideMs?: number) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(next);
    if (next && autoHideMs) {
      toastTimer.current = window.setTimeout(() => setToast(null), autoHideMs);
    }
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

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
      notify({ type: "success", message: "Scène enregistrée." }, 3000);
    } catch (error) {
      console.error("Failed to save scene:", error);
      notify({
        type: "error",
        message: error instanceof Error ? error.message : "Erreur lors de l'enregistrement de la scène.",
      }, 6000);
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
    heading.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    heading.classList.add("highlight-flash");
    setTimeout(() => heading.classList.remove("highlight-flash"), 1600);
  }, []);

  const handleRegenerateScene = useCallback((sceneId: number) => {
    if (!reportId || regeneratingSceneId !== null) return;
    setRegeneratePromptSceneId(sceneId);
    setRegenerateInstruction("");
  }, [reportId, regeneratingSceneId]);

  const closeRegeneratePrompt = useCallback(() => {
    setRegeneratePromptSceneId(null);
    setRegenerateInstruction("");
  }, []);

  const handleConfirmRegenerate = useCallback(async () => {
    if (!reportId || regeneratePromptSceneId === null || regeneratingSceneId !== null) return;

    const sceneId = regeneratePromptSceneId;
    const instruction = regenerateInstruction.trim();
    setRegeneratePromptSceneId(null);
    setRegenerateInstruction("");
    setRegeneratingSceneId(sceneId);
    notify({ type: "loading", message: `Réécriture de la scène ${sceneId}…` });

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

      notify({ type: "success", message: `Scène ${sceneId} réécrite.` }, 3000);
    } catch (error) {
      console.error("Failed to regenerate scene:", error);
      notify({
        type: "error",
        message: error instanceof Error ? error.message : "Erreur lors de la régénération de la scène.",
      }, 6000);
    } finally {
      setRegeneratingSceneId(null);
    }
  }, [reportId, regeneratePromptSceneId, regenerateInstruction, regeneratingSceneId, onReportUpdate, notify]);

  const handleRebuild = useCallback(async () => {
    if (!reportId || isRebuilding) return;
    setIsRebuilding(true);
    notify({ type: "loading", message: "Reconstruction du rapport…" });

    try {
      const result = await rebuildReport(reportId);

      if (onReportUpdate) {
        onReportUpdate(result.reportMd);
      }

      notify({ type: "success", message: "Rapport reconstruit." }, 3000);
    } catch (error) {
      console.error("Failed to rebuild report:", error);
      notify({
        type: "error",
        message: error instanceof Error ? error.message : "Erreur lors de la reconstruction du rapport.",
      }, 6000);
    } finally {
      setIsRebuilding(false);
    }
  }, [reportId, isRebuilding, onReportUpdate, notify]);

  const handleDownload = () => {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = meta?.createdAt
      ? new Date(meta.createdAt.replace(" ", "T") + (meta.createdAt.includes("T") ? "" : "Z"))
      : new Date();
    const day = Number.isNaN(date.getTime()) ? new Date() : date;
    a.href = url;
    a.download = `cr-session-${day.toISOString().split("T")[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify({ type: "error", message: "Impossible de copier : le navigateur a refusé l'accès au presse-papiers." }, 5000);
    }
  };

  // ── Text selection handling ────────────────────────────────────────────────

  const handleSelectionEnd = useCallback(
    (e: Event) => {
      if (!onCorrection || isCorrecting || showCorrectionPanel) return;

      if (correctionButtonRef.current?.contains(e.target as Node)) {
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
        const containerRect = reportContentRef.current.getBoundingClientRect();
        const left = rect.left - containerRect.left + rect.width / 2;
        setSelectedText(text);
        setSelectionPosition({
          top: rect.top - containerRect.top + rect.height + 8,
          left: Math.min(Math.max(left, 64), containerRect.width - 64),
        });
      }
    },
    [onCorrection, isCorrecting, showCorrectionPanel]
  );

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") handleSelectionEnd(e);
    };
    const onTouchEnd = (e: TouchEvent) => {
      window.setTimeout(() => handleSelectionEnd(e), 300);
    };
    document.addEventListener("mouseup", handleSelectionEnd);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("touchend", onTouchEnd);
    return () => {
      document.removeEventListener("mouseup", handleSelectionEnd);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [handleSelectionEnd]);

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
        range.setStart(node, Math.max(0, matchIndex - start));
        rangeStartSet = true;
      }
      range.setEnd(node, Math.min(matchEnd - start, nodeLen));
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
      notify({ type: "loading", message: "Correction en cours…" });
    }
    if (prevIsCorrecting.current && !isCorrecting) {
      const reportChanged = report !== reportBeforeCorrection.current;
      if (reportChanged) {
        notify({ type: "success", message: "Correction appliquée." }, 3000);
      } else {
        notify(null);
      }
    }
    prevIsCorrecting.current = isCorrecting;
  }, [isCorrecting, report, notify]);

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
          closeRegeneratePrompt();
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
  }, [showCorrectionPanel, isCorrecting, editingSceneId, isSavingScene, regeneratePromptSceneId, closeRegeneratePrompt]);

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
    if (!onCorrection || !selectedText || !correctionInstruction.trim()) return;

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
      void handleSubmitCorrection();
    }
  };

  // ── Scene tracking ─────────────────────────────────────────────────────────

  const narrativeScenes = useMemo(
    () => scenes.filter((s) => s.type !== "meta" && s.type !== "pause"),
    [scenes]
  );

  useEffect(() => {
    if (narrativeScenes.length === 0) {
      setActiveSceneId(null);
      setRenderedSceneIds([]);
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
    let ticking = false;

    const update = () => {
      ticking = false;
      setShowBackToTop((prev) => {
        const next = window.scrollY > 1400;
        return prev === next ? prev : next;
      });

      const container = reportContentRef.current;
      if (!container || narrativeScenes.length === 0) return;
      // Query on every tick: headings are re-created when the report or the
      // editing state changes, so a cached list would point to detached nodes.
      const headings = container.querySelectorAll<HTMLElement>("h2[data-scene-id]");
      if (headings.length === 0) return;

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
      window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [report, narrativeScenes, editingSceneId]);

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

  // ── Markdown renderers ─────────────────────────────────────────────────────

  const markdownComponents = useMemo<Components>(() => {
    const renderState = { suppress: false };

    return {
      h1: ({ children, ...props }) => {
        // The report title is shown in the page header; don't repeat it.
        if (getTextContent(children).trim() === title.raw) return null;
        return <h2 {...props}>{children}</h2>;
      },
      h2: ({ children, ...props }) => {
        renderState.suppress = false;

        const headingText = getTextContent(children).trim().replace(/^Chapitre \d+\s*:\s*/, "");
        const scene = narrativeScenes.find((s) => s.title === headingText);

        if (!scene) {
          return <h2 {...props}>{children}</h2>;
        }
        const type = SCENE_TYPES[scene.type] ?? SCENE_TYPES.narrative;
        const TypeIcon = type.icon;
        const eyebrow = (
          <p className="!mb-0 mt-12 flex items-center gap-1.5 font-sans text-sm text-ink-muted" aria-hidden="true">
            <TypeIcon className={`h-3.5 w-3.5 ${type.color}`} />
            Scène {scene.id} · {type.label}
          </p>
        );
        const headingProps = {
          ...props,
          id: `scene-${scene.id}`,
          "data-scene-id": scene.id,
          className: "scene-heading !mt-1 flex items-start justify-between gap-4",
          style: { scrollMarginTop: "2.5rem" },
        };

        if (editingSceneId === scene.id) {
          renderState.suppress = true;
          const { editingScene: es, onSave, onCancel, isSaving } = inlineEditRef.current;

          return (
            <>
              {eyebrow}
              <h2 {...headingProps}>
                <span>{children}</span>
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

        return (
          <>
            {eyebrow}
            <h2 {...headingProps}>
              <span>{children}</span>
              {reportId && !editingSceneId && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSceneId(scene.id);
                  }}
                  className="scene-heading-action btn-secondary btn-sm mt-1 shrink-0 font-sans"
                  aria-label={`Modifier la scène ${scene.id} : ${scene.title}`}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Modifier</span>
                </button>
              )}
            </h2>
          </>
        );
      },
      p: ({ children, ...props }) => {
        if (renderState.suppress) return null;

        // "*📍 Lieu*" line right under a scene title.
        const only = Array.isArray(children) && children.length === 1 ? children[0] : children;
        const text = getTextContent(children).trim();
        if (text.startsWith("📍") && typeof only === "object") {
          return (
            <p className="scene-location">
              <MapPin className="h-4 w-4 shrink-0 text-accent-ink" aria-hidden="true" />
              <span>
                <span className="sr-only">Lieu : </span>
                {text.replace(LEADING_EMOJI, "")}
              </span>
            </p>
          );
        }

        return <p {...props}>{children}</p>;
      },
      strong: ({ children, ...props }) => {
        const { icon: Icon, children: rest } = withIcon(children);
        if (!Icon) return <strong {...props}>{rest}</strong>;
        return (
          <strong {...props} className="box-label">
            <Icon aria-hidden="true" />
            {rest}
          </strong>
        );
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
      table: ({ children, ...props }) => (
        <div className="overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      ),
      hr: () => {
        renderState.suppress = false;
        return <hr aria-hidden="true" />;
      },
    };
  }, [narrativeScenes, reportId, editingSceneId, title.raw]);

  // Memoized so scroll-driven state (active scene, back-to-top) never
  // re-renders the whole report.
  const renderedMarkdown = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {report}
      </ReactMarkdown>
    ),
    // editingScene / isSavingScene are read through inlineEditRef, listed so
    // the inline editor still refreshes.
    [report, markdownComponents, editingScene, isSavingScene]
  );

  const promptScene =
    regeneratePromptSceneId !== null ? scenes.find((s) => s.id === regeneratePromptSceneId) : null;

  const copyButton = (compact = false) => (
    <button type="button" onClick={() => void handleCopy()} className={`btn-secondary btn-sm ${compact ? "flex-1" : ""}`}>
      {copied ? <CheckCheck className="h-4 w-4 text-ok" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copié" : "Copier"}</span>
    </button>
  );

  const downloadButton = (compact = false) => (
    <button type="button" onClick={handleDownload} className={`btn-secondary btn-sm ${compact ? "flex-1" : ""}`}>
      <Download className="h-4 w-4" aria-hidden="true" />
      {compact ? ".md" : "Télécharger (.md)"}
    </button>
  );

  // A title that only repeats the universe says nothing: name the session by its date.
  const genericTitle = !!meta?.universeLabel && title.display === meta.universeLabel;
  const heading =
    genericTitle && meta?.createdAt ? `Session du ${formatDate(meta.createdAt)}` : title.display;
  const metaParts = [
    meta?.universeLabel,
    !genericTitle && meta?.createdAt ? formatDate(meta.createdAt) : null,
    narrativeScenes.length > 0 ? `${narrativeScenes.length} scènes` : null,
    meta?.transcriptName,
    typeof meta?.costUsd === "number" ? `coût ≈ ${meta.costUsd.toFixed(meta.costUsd < 1 ? 3 : 2)} $` : null,
  ].filter(Boolean);

  return (
    <div>
      {/* Status toast */}
      <div
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:top-6 sm:bottom-auto"
        role={toast?.type === "error" ? "alert" : "status"}
        aria-live={toast?.type === "error" ? "assertive" : "polite"}
      >
        {toast && (
          <div
            className={`pointer-events-auto flex max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 shadow-raised animate-rise-in ${
              toast.type === "error" ? "border-danger/40" : toast.type === "success" ? "border-ok/40" : "border-line-strong"
            }`}
          >
            {toast.type === "loading" && <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-accent-ink" aria-hidden="true" />}
            {toast.type === "success" && (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok text-surface" aria-hidden="true">
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </span>
            )}
            {toast.type === "error" && <OctagonAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />}
            <p className="text-sm font-medium text-ink">{toast.message}</p>
            {toast.type === "error" && (
              <button type="button" onClick={() => notify(null)} className="-mr-1 text-sm font-medium text-ink-muted underline underline-offset-2 hover:text-ink">
                Fermer
              </button>
            )}
          </div>
        )}
      </div>

      {/* Report header */}
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink">{heading}</h1>
          {metaParts.length > 0 && (
            <p className="mt-0.5 text-sm text-ink-muted">{metaParts.join(" · ")}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {copyButton()}
          {downloadButton()}
          {onNewSession && (
            <button type="button" onClick={onNewSession} className="btn-primary btn-sm">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouvelle session
            </button>
          )}
        </div>
      </header>

      {onCorrection && (
        <p className="mb-6 text-sm text-ink-muted lg:hidden">
          Astuce : sélectionne un passage du récit pour demander une correction.
        </p>
      )}

      {/* Correction dialog */}
      {showCorrectionPanel && (
        <Modal
          title="Corriger un passage"
          icon={<Pencil className="h-5 w-5" />}
          onClose={handleCloseCorrectionPanel}
          closeDisabled={isCorrecting}
          footer={
            <>
              <button type="button" onClick={handleCloseCorrectionPanel} className="btn-secondary">
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitCorrection()}
                disabled={!correctionInstruction.trim()}
                className="btn-primary"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Appliquer la correction
              </button>
            </>
          }
        >
          <p className="mb-2 text-sm font-medium text-ink">Passage sélectionné</p>
          <blockquote className="mb-5 max-h-32 overflow-y-auto rounded-lg border-l-[3px] border-line-strong bg-sunken px-4 py-3 font-serif text-base italic text-ink">
            « {selectedText} »
          </blockquote>
          <label htmlFor="correction-instruction" className="label">
            Que faut-il corriger ?
          </label>
          <textarea
            ref={textareaRef}
            id="correction-instruction"
            value={correctionInstruction}
            onChange={(e) => setCorrectionInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ex. : ce n'est pas Yumi qui lance le sort mais Kael…"
            className="textarea"
            rows={4}
            aria-describedby="correction-hint"
          />
          <p id="correction-hint" className="mt-2 text-sm text-ink-muted">
            {SHORTCUT_KEY}+Entrée pour envoyer
          </p>
        </Modal>
      )}

      {/* Regeneration dialog */}
      {regeneratePromptSceneId !== null && (
        <Modal
          title="Réécrire la scène"
          icon={<RefreshCw className="h-5 w-5" />}
          onClose={closeRegeneratePrompt}
          footer={
            <>
              <button type="button" onClick={closeRegeneratePrompt} className="btn-secondary">
                Annuler
              </button>
              <button type="button" onClick={() => void handleConfirmRegenerate()} className="btn-primary">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Réécrire la scène
              </button>
            </>
          }
        >
          {promptScene && (
            <p className="mb-5 rounded-lg bg-sunken px-4 py-3 text-sm text-ink">
              <span className="font-semibold">Scène {promptScene.id}</span>
              <span className="mx-1.5 text-ink-muted" aria-hidden="true">·</span>
              {promptScene.title}
            </p>
          )}
          <p className="mb-4 text-sm text-ink-muted">
            Le texte actuel de la scène sera remplacé.
          </p>
          <label htmlFor="regenerate-instruction" className="label">
            Que faut-il changer ? <span className="font-normal text-ink-muted">(facultatif)</span>
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
            placeholder="Ex. : le MJ ne doit pas apparaître dans le récit, c'est Stan qui explique ce point…"
            className="textarea"
            rows={3}
            aria-describedby="regenerate-hint"
          />
          <p id="regenerate-hint" className="mt-2 text-sm text-ink-muted">
            {SHORTCUT_KEY}+Entrée pour lancer · laisse vide pour une simple réécriture
          </p>
        </Modal>
      )}

      <div
        className={
          scenes.length > 0
            ? "space-y-5 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start lg:gap-8 lg:space-y-0"
            : ""
        }
      >
        {scenes.length > 0 && (
          <aside className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
            <SceneBar
              scenes={scenes}
              renderedSceneIds={renderedSceneIds}
              onScrollToScene={handleScrollToScene}
              onRegenerate={handleRegenerateScene}
              onRebuild={handleRebuild}
              regeneratingSceneId={regeneratingSceneId}
              isRebuilding={isRebuilding}
              activeSceneId={activeSceneId}
              footer={
                <div className="hidden gap-2 lg:flex">
                  {copyButton(true)}
                  {downloadButton(true)}
                </div>
              }
            />
          </aside>
        )}

        <article
          aria-label="Compte-rendu"
          className="card relative px-5 py-6 sm:px-8 sm:py-8"
        >
          <div className="prose-report" ref={reportContentRef}>
            {renderedMarkdown}
          </div>

          {/* Floating correction button */}
          {selectedText && selectionPosition && !showCorrectionPanel && onCorrection && (
            <div
              ref={correctionButtonRef}
              className="absolute z-40"
              style={{
                top: `${selectionPosition.top + (reportContentRef.current?.offsetTop ?? 0)}px`,
                left: `${selectionPosition.left + (reportContentRef.current?.offsetLeft ?? 0)}px`,
                transform: "translateX(-50%)",
              }}
            >
              <div className="correction-button-container">
                <div className="correction-button-arrow" />
                <button
                  type="button"
                  onClick={handleOpenCorrectionPanel}
                  className="btn-primary btn-sm shadow-raised"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Corriger ce passage
                </button>
              </div>
            </div>
          )}

          <footer className="mx-auto mt-12 max-w-[42rem] border-t border-line pt-6">
            <div className="flex flex-wrap justify-end gap-2">
              {downloadButton()}
              {onNewSession && (
                <button type="button" onClick={onNewSession} className="btn-primary btn-sm">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Nouvelle session
                </button>
              )}
            </div>
          </footer>
        </article>
      </div>

      {showBackToTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}
          className="icon-btn fixed bottom-5 right-5 z-30 h-12 w-12 rounded-full border border-line-strong bg-surface shadow-raised animate-fade-in lg:hidden"
          aria-label="Revenir en haut du compte-rendu"
        >
          <ArrowUp className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
