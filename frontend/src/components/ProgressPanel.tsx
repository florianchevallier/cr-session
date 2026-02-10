import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Search,
  BookOpen,
  ShieldCheck,
  FileOutput,
  Cog,
  FileText,
} from "lucide-react";
import type { StepEvent } from "../hooks/useSSE";

const STEP_ICONS: Record<string, React.ReactNode> = {
  preprocessor: <Cog className="h-4 w-4" />,
  analyst: <Search className="h-4 w-4" />,
  summarizer: <BookOpen className="h-4 w-4" />,
  validator: <ShieldCheck className="h-4 w-4" />,
  formatter: <FileOutput className="h-4 w-4" />,
};

const STEP_NAMES: Record<string, string> = {
  preprocessor: "Preprocessing",
  analyst: "Analyse",
  summarizer: "Resume par scene",
  validator: "Validation par scene",
  formatter: "Mise en forme",
};

const MAIN_STEP_ORDER = [
  "preprocessor",
  "analyst",
  "summarizer",
  "validator",
  "formatter",
] as const;

function getSceneGroup(stepId: string): "summarizer" | "validator" | null {
  if (stepId.startsWith("summarizer_scene_")) return "summarizer";
  if (stepId.startsWith("validator_scene_")) return "validator";
  return null;
}

function isSceneStep(stepId: string): boolean {
  return getSceneGroup(stepId) !== null;
}

function getStepStatus(step: StepEvent): "pending" | "in_progress" | "completed" {
  const raw = step.data?.status;
  if (raw === "in_progress" || raw === "completed") return raw;
  return "pending";
}

function getSceneId(step: StepEvent): number {
  const fromData = step.data?.sceneId;
  if (typeof fromData === "number") return fromData;
  const match = step.step.match(/_(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]);
}

interface ProgressPanelProps {
  steps: StepEvent[];
  currentStep: string | null;
  error: string | null;
  isProcessing: boolean;
}

export default function ProgressPanel({
  steps,
  currentStep: _currentStep,
  error,
  isProcessing,
}: ProgressPanelProps) {
  if (steps.length === 0 && !error) return null;

  const latestById = steps.reduce((map, step) => {
    map.set(step.step, step);
    return map;
  }, new Map<string, StepEvent>());

  const allSteps = Array.from(latestById.values());

  const mainSteps = MAIN_STEP_ORDER
    .map((id) => latestById.get(id))
    .filter((s): s is StepEvent => !!s);

  const summarizerSceneSteps = allSteps
    .filter((s) => getSceneGroup(s.step) === "summarizer")
    .sort((a, b) => getSceneId(a) - getSceneId(b));

  const validatorSceneSteps = allSteps
    .filter((s) => getSceneGroup(s.step) === "validator")
    .sort((a, b) => getSceneId(a) - getSceneId(b));

  const extraSteps = allSteps.filter(
    (s) => !isSceneStep(s.step) && !MAIN_STEP_ORDER.includes(s.step as (typeof MAIN_STEP_ORDER)[number])
  );

  const orderedMainSteps = [...mainSteps, ...extraSteps];

  return (
    <div className="card p-6">
      <h3 className="mb-4 text-sm font-semibold text-parchment-900">Progression</h3>

      <div className="space-y-3">
        {orderedMainSteps.map((step) => {
          const childSteps =
            step.step === "summarizer"
              ? summarizerSceneSteps
              : step.step === "validator"
                ? validatorSceneSteps
                : [];

          const status = getStepStatus(step);
          const childActive = childSteps.some((child) => getStepStatus(child) === "in_progress");
          const childDone =
            childSteps.length > 0 &&
            childSteps.every((child) => getStepStatus(child) === "completed");

          const isActive = status === "in_progress" || childActive;
          const isDone =
            status === "completed" ||
            childDone ||
            (!isProcessing && status !== "in_progress");

          return (
            <div key={step.step}>
              <div
                className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-all ${
                  isActive ? "bg-parchment-50 ring-1 ring-parchment-300" : isDone ? "opacity-70" : ""
                }`}
              >
                <div
                  className={`mt-0.5 flex-shrink-0 ${
                    isActive ? "text-parchment-600" : isDone ? "text-green-500" : "text-parchment-400"
                  }`}
                >
                  {isActive ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isDone ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    STEP_ICONS[step.step] || <Cog className="h-4 w-4" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${isActive ? "text-parchment-900" : "text-parchment-600"}`}>
                    {STEP_NAMES[step.step] || step.step}
                  </p>
                  <p className="text-xs text-parchment-500 truncate">{step.label}</p>

                  {step.data && step.step === "analyst" && isDone && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <span className="inline-flex items-center rounded-full bg-parchment-100 px-2 py-0.5 text-xs text-parchment-700">
                        {String((step.data.scenesCount as number) || 0)} scenes
                        {step.data.narrativeScenesCount != null && (
                          <> ({String(step.data.narrativeScenesCount)} narratives)</>
                        )}
                      </span>
                      {step.data.speakerMap ? (
                        <span className="inline-flex items-center rounded-full bg-parchment-100 px-2 py-0.5 text-xs text-parchment-700">
                          {String(
                            Object.keys(step.data.speakerMap as Record<string, unknown>).length
                          )}{" "}
                          speakers
                        </span>
                      ) : null}
                    </div>
                  )}

                  {step.data && (step.step === "summarizer" || step.step === "validator") && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {step.data.totalScenes != null && (
                        <span className="inline-flex items-center rounded-full bg-parchment-100 px-2 py-0.5 text-xs text-parchment-700">
                          {String(step.data.totalScenes)} scenes ciblees
                        </span>
                      )}
                      {step.step === "summarizer" && step.data.summariesCount != null && (
                        <span className="inline-flex items-center rounded-full bg-parchment-100 px-2 py-0.5 text-xs text-parchment-700">
                          {String(step.data.summariesCount)} resumees
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {childSteps.length > 0 && (
                <div className="ml-6 mt-1 space-y-1 border-l-2 border-parchment-200 pl-3">
                  {childSteps.map((sceneStep) => {
                    const sceneStatus = getStepStatus(sceneStep);
                    const sceneActive = sceneStatus === "in_progress";
                    const sceneDone =
                      sceneStatus === "completed" ||
                      (!isProcessing && sceneStatus !== "in_progress");

                    return (
                      <div
                        key={sceneStep.step}
                        className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-all ${
                          sceneActive ? "bg-amber-50 ring-1 ring-amber-200" : ""
                        }`}
                      >
                        <div className="mt-0.5 flex-shrink-0 text-parchment-500">
                          {sceneActive ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : sceneDone ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                          ) : sceneStep.step.startsWith("validator_scene_") ? (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={sceneActive ? "font-medium text-parchment-900" : "text-parchment-600"}>
                            {sceneStep.label}
                          </p>
                          {sceneStep.data && sceneStep.data.startLine != null && (
                            <p className="mt-0.5 text-parchment-400">
                              Lignes {String(sceneStep.data.startLine)}-{String(sceneStep.data.endLine)} uniquement
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
