import {
  BookOpen,
  Swords,
  MessageSquare,
  Compass,
  Settings,
  Coffee,
  RefreshCw,
  Check,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Hammer,
  Eye,
  EyeOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneWithSummary } from "../lib/api";

interface SceneBarProps {
  scenes: SceneWithSummary[];
  renderedSceneIds: number[];
  onScrollToScene: (sceneId: number) => void;
  onRegenerate: (sceneId: number) => void;
  onRebuild: () => Promise<void>;
  regeneratingSceneId: number | null;
  isRebuilding: boolean;
  activeSceneId: number | null;
}

const TYPE_CONFIG: Record<
  string,
  { icon: typeof BookOpen; label: string; color: string }
> = {
  narrative: { icon: BookOpen, label: "Narratif", color: "text-blue-600" },
  combat: { icon: Swords, label: "Combat", color: "text-red-600" },
  social: { icon: MessageSquare, label: "Social", color: "text-violet-600" },
  exploration: { icon: Compass, label: "Exploration", color: "text-emerald-600" },
  meta: { icon: Settings, label: "Méta", color: "text-parchment-400" },
  pause: { icon: Coffee, label: "Pause", color: "text-parchment-400" },
};

function SceneChip({
  scene,
  onScrollToScene,
  onRegenerate,
  isRegenerating,
  isActive,
  isInReport,
}: {
  scene: SceneWithSummary;
  onScrollToScene: (sceneId: number) => void;
  onRegenerate: (sceneId: number) => void;
  isRegenerating: boolean;
  isActive: boolean;
  isInReport: boolean;
}) {
  const isExcluded = scene.type === "meta" || scene.type === "pause";
  const [showMaskedDetails, setShowMaskedDetails] = useState(false);
  const hasMaskedDetails = isExcluded && (!!scene.transcriptExcerpt || !!scene.analystSummary);
  const hasSummary = !!scene.summary;
  const isMissing = !isExcluded && !hasSummary;
  const isOutOfReport = !isExcluded && hasSummary && !isInReport;
  const isHighlighted = !isExcluded && isActive;
  const config = TYPE_CONFIG[scene.type] ?? TYPE_CONFIG.narrative;
  const Icon = config.icon;

  return (
    <div
      data-scene-chip-id={scene.id}
      className={`rounded-lg border px-3 py-2 text-xs transition-all ${
        isExcluded
          ? "border-parchment-200 bg-parchment-50/50 text-parchment-400"
          : isHighlighted
            ? "border-amber-400 bg-amber-50 text-amber-900 shadow-sm"
            : isOutOfReport
              ? "border-parchment-200 bg-parchment-50/70 text-parchment-500"
          : isMissing
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-parchment-200 bg-white hover:border-parchment-400 text-parchment-700 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${config.color}`} />
          {isHighlighted && (
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
          )}
          <span className="font-medium flex-shrink-0">{scene.id}.</span>
          {!isExcluded ? (
            <button
              onClick={() => onScrollToScene(scene.id)}
              disabled={!isInReport}
              className={`truncate text-left ${
                isHighlighted
                  ? "font-semibold text-amber-900"
                  : isInReport
                    ? "hover:underline"
                    : "cursor-not-allowed text-parchment-400"
              }`}
              title={scene.title}
            >
              {scene.title}
            </button>
          ) : (
            <span className="truncate" title={scene.title}>
              {scene.title}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {isExcluded ? (
            <>
              <span className="text-[10px] text-parchment-400 italic">
                {config.label}
              </span>
              {hasMaskedDetails && (
                <button
                  onClick={() => setShowMaskedDetails((prev) => !prev)}
                  className="ml-1 p-1 rounded-md text-parchment-400 hover:text-parchment-600 hover:bg-parchment-100 transition-all"
                  title={
                    showMaskedDetails
                      ? "Masquer le contenu de la scène"
                      : "Afficher le contenu de la scène"
                  }
                >
                  {showMaskedDetails ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </>
          ) : isMissing ? (
            <>
              <AlertTriangle className="h-3 w-3 text-amber-500" />
              <span className="text-[10px] text-amber-600 font-medium">
                Absente
              </span>
            </>
          ) : isOutOfReport ? (
            <>
              <EyeOff className="h-3 w-3 text-parchment-400" />
              <span className="text-[10px] text-parchment-500 font-medium">
                Hors rapport
              </span>
            </>
          ) : (
            <Check className="h-3 w-3 text-green-500" />
          )}

          {!isExcluded && (
            <button
              onClick={() => onRegenerate(scene.id)}
              disabled={isRegenerating}
              className={`ml-1 p-1 rounded-md transition-all ${
                isRegenerating
                  ? "text-amber-500 cursor-wait"
                  : isMissing
                    ? "text-amber-600 hover:bg-amber-100"
                    : "text-parchment-400 hover:text-parchment-600 hover:bg-parchment-100"
              }`}
              title={
                isMissing
                  ? "Générer cette scène"
                  : "Regénérer cette scène"
              }
            >
              {isRegenerating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {isExcluded && showMaskedDetails && (
        <div className="mt-2 rounded-md border border-parchment-200 bg-white/75 px-2.5 py-2 text-[11px] text-parchment-700 space-y-2">
          {scene.analystSummary && (
            <p className="italic">
              {scene.analystSummary}
            </p>
          )}
          {scene.transcriptExcerpt ? (
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono leading-relaxed text-[10px] text-parchment-600">
              {scene.transcriptExcerpt}
            </pre>
          ) : (
            <p className="italic text-parchment-500">
              Extrait de transcript indisponible pour cette scène.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function SceneBar({
  scenes,
  renderedSceneIds,
  onScrollToScene,
  onRegenerate,
  onRebuild,
  regeneratingSceneId,
  isRebuilding,
  activeSceneId,
}: SceneBarProps) {
  const [expanded, setExpanded] = useState(true);
  const [showMaskedScenes, setShowMaskedScenes] = useState(false);
  const chipsContainerRef = useRef<HTMLDivElement>(null);

  const renderedSet = useMemo(() => new Set(renderedSceneIds), [renderedSceneIds]);
  const narrativeScenes = scenes.filter(
    (s) => s.type !== "meta" && s.type !== "pause"
  );
  const maskedScenes = scenes.filter(
    (s) => s.type === "meta" || s.type === "pause"
  );
  const scenesToDisplay = showMaskedScenes ? scenes : narrativeScenes;
  const totalNarrative = narrativeScenes.length;
  const withSummary = narrativeScenes.filter((s) => s.summary).length;
  const missing = totalNarrative - withSummary;
  const outOfReport = narrativeScenes.filter(
    (s) => s.summary && !renderedSet.has(s.id)
  ).length;

  useEffect(() => {
    if (!chipsContainerRef.current || activeSceneId === null || !expanded) return;

    const chipsContainer = chipsContainerRef.current;
    const activeChip = chipsContainer.querySelector<HTMLElement>(
      `[data-scene-chip-id="${activeSceneId}"]`
    );

    if (!activeChip) return;

    // Keep the active chip visible without scrolling the whole page on mobile.
    const chipTop = activeChip.offsetTop;
    const chipBottom = chipTop + activeChip.offsetHeight;
    const viewportTop = chipsContainer.scrollTop;
    const viewportBottom = viewportTop + chipsContainer.clientHeight;

    if (chipTop < viewportTop) {
      chipsContainer.scrollTo({
        top: Math.max(0, chipTop - 8),
        behavior: "smooth",
      });
      return;
    }

    if (chipBottom > viewportBottom) {
      chipsContainer.scrollTo({
        top: chipBottom - chipsContainer.clientHeight + 8,
        behavior: "smooth",
      });
    }
  }, [activeSceneId, expanded, showMaskedScenes]);

  if (scenes.length === 0) return null;

  return (
    <div className="card border-parchment-200 overflow-hidden lg:max-h-[calc(100vh-3rem)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-parchment-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-parchment-800">
            Navigation des scènes
          </h3>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-parchment-500">
              {withSummary}/{totalNarrative}
            </span>
            {missing > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                <AlertTriangle className="h-2.5 w-2.5" />
                {missing} absente{missing > 1 ? "s" : ""}
              </span>
            )}
            {outOfReport > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-parchment-100 px-2 py-0.5 text-[10px] font-medium text-parchment-600">
                <EyeOff className="h-2.5 w-2.5" />
                {outOfReport} hors rapport
              </span>
            )}
            {maskedScenes.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-parchment-100 px-2 py-0.5 text-[10px] font-medium text-parchment-600">
                <EyeOff className="h-2.5 w-2.5" />
                {maskedScenes.length} masquée{maskedScenes.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-parchment-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-parchment-400" />
        )}
      </button>

      {expanded && (
        <div
          ref={chipsContainerRef}
          className="px-4 pb-3 space-y-1.5 max-h-72 overflow-y-auto lg:max-h-[calc(100vh-8.5rem)]"
        >
          {maskedScenes.length > 0 && (
            <button
              onClick={() => setShowMaskedScenes((prev) => !prev)}
              className="w-full mb-1 flex items-center justify-center gap-2 rounded-lg border border-parchment-200 bg-parchment-50/60 px-3 py-2 text-xs font-medium text-parchment-700 hover:bg-parchment-100/70 transition-all"
            >
              {showMaskedScenes ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              {showMaskedScenes
                ? "Masquer les scènes méta/pause"
                : `Afficher ${maskedScenes.length} scène${maskedScenes.length > 1 ? "s" : ""} masquée${maskedScenes.length > 1 ? "s" : ""}`}
            </button>
          )}

          {scenesToDisplay.map((scene) => (
            <SceneChip
              key={scene.id}
              scene={scene}
              onScrollToScene={onScrollToScene}
              onRegenerate={onRegenerate}
              isRegenerating={regeneratingSceneId === scene.id}
              isActive={activeSceneId === scene.id}
              isInReport={renderedSet.has(scene.id)}
            />
          ))}

          {outOfReport > 0 && (
            <button
              onClick={() => void onRebuild()}
              disabled={isRebuilding}
              className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/50 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100/50 hover:border-amber-400 transition-all disabled:opacity-50"
            >
              {isRebuilding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Hammer className="h-3.5 w-3.5" />
              )}
              {isRebuilding
                ? "Reconstruction..."
                : `Reconstruire le rapport (${outOfReport} scène${outOfReport > 1 ? "s" : ""} manquante${outOfReport > 1 ? "s" : ""})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
