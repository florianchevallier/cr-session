import {
  BookOpen,
  Swords,
  MessageSquare,
  Compass,
  Settings,
  Coffee,
  RefreshCw,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Hammer,
  Eye,
  EyeOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SceneWithSummary } from "../lib/api";
import { plural } from "../lib/format";

interface SceneBarProps {
  scenes: SceneWithSummary[];
  renderedSceneIds: number[];
  onScrollToScene: (sceneId: number) => void;
  onRegenerate: (sceneId: number) => void;
  onRebuild: () => Promise<void>;
  regeneratingSceneId: number | null;
  isRebuilding: boolean;
  activeSceneId: number | null;
  footer?: ReactNode;
}

export const SCENE_TYPES: Record<
  string,
  { icon: typeof BookOpen; label: string; color: string }
> = {
  narrative: { icon: BookOpen, label: "Récit", color: "text-scene-narrative" },
  combat: { icon: Swords, label: "Combat", color: "text-scene-combat" },
  social: { icon: MessageSquare, label: "Social", color: "text-scene-social" },
  exploration: { icon: Compass, label: "Exploration", color: "text-scene-exploration" },
  meta: { icon: Settings, label: "Hors jeu", color: "text-ink-subtle" },
  pause: { icon: Coffee, label: "Pause", color: "text-ink-subtle" },
};

const isMasked = (s: SceneWithSummary) => s.type === "meta" || s.type === "pause";

function SceneRow({
  scene,
  onScrollToScene,
  onRegenerate,
  isRegenerating,
  regenerationBusy,
  isActive,
  isInReport,
}: {
  scene: SceneWithSummary;
  onScrollToScene: (sceneId: number) => void;
  onRegenerate: (sceneId: number) => void;
  isRegenerating: boolean;
  regenerationBusy: boolean;
  isActive: boolean;
  isInReport: boolean;
}) {
  const excluded = isMasked(scene);
  const [showDetails, setShowDetails] = useState(false);
  const hasDetails = excluded && (!!scene.transcriptExcerpt || !!scene.synopsis);
  const isMissing = !excluded && !scene.summary;
  const isOutOfReport = !excluded && !!scene.summary && !isInReport;
  const config = SCENE_TYPES[scene.type] ?? SCENE_TYPES.narrative;
  const Icon = config.icon;
  const status = isMissing ? "Absente" : isOutOfReport ? "Hors rapport" : null;

  return (
    <li data-scene-chip-id={scene.id}>
      <div
        className={`relative flex items-center gap-1 rounded-lg transition-colors duration-150 ${
          isActive ? "bg-accent-soft" : "hover:bg-sunken"
        }`}
      >
        {isActive && (
          <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" aria-hidden="true" />
        )}
        {excluded ? (
          <div className="flex min-h-[2.5rem] min-w-0 flex-1 items-center gap-2.5 px-3 text-sm text-ink-muted">
            <Icon className={`h-4 w-4 shrink-0 ${config.color}`} aria-hidden="true" />
            <span className="w-5 shrink-0 text-right tabular-nums">{scene.id}</span>
            <span className="truncate" title={scene.title}>
              {scene.title}
            </span>
            <span className="ml-auto shrink-0 text-xs">{config.label}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onScrollToScene(scene.id)}
            disabled={!isInReport}
            aria-current={isActive ? "location" : undefined}
            title={scene.title}
            className="flex min-h-[2.5rem] min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left text-sm disabled:cursor-not-allowed"
          >
            <Icon className={`h-4 w-4 shrink-0 ${config.color}`} aria-hidden="true" />
            <span className="sr-only">{config.label}, scène</span>
            <span className={`w-5 shrink-0 text-right tabular-nums ${isActive ? "text-accent-ink" : "text-ink-muted"}`}>
              {scene.id}
            </span>
            <span className="flex min-w-0 flex-1 flex-col py-2">
              <span className={`line-clamp-2 leading-snug ${isActive ? "font-semibold text-ink" : isInReport ? "text-ink" : "text-ink-muted"}`}>
                {scene.title}
              </span>
              {status && (
                <span
                  className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${
                    isMissing ? "text-warn" : "text-ink-muted"
                  }`}
                >
                  {isMissing && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
                  {status}
                </span>
              )}
            </span>
          </button>
        )}

        {excluded
          ? hasDetails && (
              <button
                type="button"
                onClick={() => setShowDetails((prev) => !prev)}
                className="icon-btn h-9 w-9"
                aria-expanded={showDetails}
                aria-label={`${showDetails ? "Masquer" : "Afficher"} le contenu de la scène ${scene.id}`}
              >
                {showDetails ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            )
          : (
              <button
                type="button"
                onClick={() => onRegenerate(scene.id)}
                disabled={regenerationBusy}
                className={`icon-btn h-9 w-9 ${isMissing ? "text-warn" : ""} ${isRegenerating ? "cursor-wait" : ""}`}
                aria-label={`${isMissing ? "Générer" : "Régénérer"} la scène ${scene.id} : ${scene.title}`}
                title={isMissing ? "Générer cette scène" : "Régénérer cette scène"}
              >
                {isRegenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </button>
            )}
      </div>

      {excluded && showDetails && (
        <div className="mx-3 mb-2 mt-1 space-y-2 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-muted">
          {scene.synopsis && <p className="italic">{scene.synopsis}</p>}
          {scene.transcriptExcerpt ? (
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {scene.transcriptExcerpt}
            </pre>
          ) : (
            <p className="italic">Extrait du transcript indisponible pour cette scène.</p>
          )}
        </div>
      )}
    </li>
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
  footer,
}: SceneBarProps) {
  const [expanded, setExpanded] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches
  );
  const [showMasked, setShowMasked] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const renderedSet = useMemo(() => new Set(renderedSceneIds), [renderedSceneIds]);
  const narrative = scenes.filter((s) => !isMasked(s));
  const masked = scenes.filter(isMasked);
  const shown = showMasked ? scenes : narrative;
  const missing = narrative.filter((s) => !s.summary).length;
  const outOfReport = narrative.filter((s) => s.summary && !renderedSet.has(s.id)).length;
  const typesPresent = Array.from(new Set(narrative.map((s) => s.type))).filter((t) => SCENE_TYPES[t]);

  useEffect(() => {
    const container = listRef.current;
    if (!container || activeSceneId === null || !expanded) return;
    const chip = container.querySelector<HTMLElement>(`[data-scene-chip-id="${activeSceneId}"]`);
    if (!chip) return;

    // Keep the active row visible inside the list without scrolling the page.
    const top = chip.offsetTop;
    const bottom = top + chip.offsetHeight;
    if (top < container.scrollTop) {
      container.scrollTo({ top: Math.max(0, top - 8) });
    } else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTo({ top: bottom - container.clientHeight + 8 });
    }
  }, [activeSceneId, expanded, showMasked]);

  if (scenes.length === 0) return null;

  return (
    <nav aria-label="Sommaire des scènes" className="card flex max-h-full flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="scene-list"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken"
      >
        <span>
          <span className="block text-base font-semibold text-ink">Sommaire</span>
          <span className="block text-sm text-ink-muted">
            {plural(narrative.length, "scène")}
            {missing > 0 && ` · ${plural(missing, "absente")}`}
            {outOfReport > 0 && ` · ${outOfReport} hors rapport`}
          </span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-ink-muted transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <>
          {typesPresent.length > 1 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-muted" aria-label="Types de scène">
              {typesPresent.map((type) => {
                const { icon: Icon, label, color } = SCENE_TYPES[type];
                return (
                  <li key={type} className="inline-flex items-center gap-1">
                    <Icon className={`h-3.5 w-3.5 ${color}`} aria-hidden="true" />
                    {label}
                  </li>
                );
              })}
            </ul>
          )}

          <div
            id="scene-list"
            ref={listRef}
            className="max-h-80 min-h-0 flex-1 overflow-y-auto border-t border-line px-2 py-2 lg:max-h-none"
          >
            <ol className="space-y-0.5">
              {shown.map((scene) => (
                <SceneRow
                  key={scene.id}
                  scene={scene}
                  onScrollToScene={onScrollToScene}
                  onRegenerate={onRegenerate}
                  isRegenerating={regeneratingSceneId === scene.id}
                  regenerationBusy={regeneratingSceneId !== null}
                  isActive={activeSceneId === scene.id}
                  isInReport={renderedSet.has(scene.id)}
                />
              ))}
            </ol>

            {masked.length > 0 && (
              <button
                type="button"
                onClick={() => setShowMasked((prev) => !prev)}
                className="btn-ghost btn-sm mt-1 w-full"
              >
                {showMasked ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                {showMasked
                  ? "Masquer les scènes hors jeu"
                  : `Afficher ${plural(masked.length, "scène hors jeu", "scènes hors jeu")}`}
              </button>
            )}

            {outOfReport > 0 && (
              <button
                type="button"
                onClick={() => void onRebuild()}
                disabled={isRebuilding}
                className="btn mt-2 w-full border border-dashed border-warn/60 bg-warn-soft text-ink hover:border-warn"
              >
                {isRebuilding ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Hammer className="h-4 w-4 text-warn" aria-hidden="true" />
                )}
                {isRebuilding
                  ? "Reconstruction…"
                  : `Reconstruire le rapport (${plural(outOfReport, "scène manquante", "scènes manquantes")})`}
              </button>
            )}
          </div>

          {footer && <div className="border-t border-line p-3">{footer}</div>}
        </>
      )}
    </nav>
  );
}
