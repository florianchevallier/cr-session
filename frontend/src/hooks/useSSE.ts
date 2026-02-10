import { useState, useCallback, useRef } from "react";
import type { ProcessConfig } from "../lib/api";

export interface StepEvent {
  step: string;
  label: string;
  data?: Record<string, unknown>;
}

export interface SSEState {
  isProcessing: boolean;
  steps: StepEvent[];
  currentStep: string | null;
  result: string | null;
  resultData: Record<string, unknown> | null;
  error: string | null;
}

type ScenePayload = {
  id: number;
  title: string;
  startLine: number;
  endLine: number;
};

function upsertStep(
  steps: StepEvent[],
  next: StepEvent,
  mergeData: boolean
): StepEvent[] {
  const idx = steps.findIndex((s) => s.step === next.step);
  if (idx === -1) return [...steps, next];

  return steps.map((s, i) =>
    i === idx
      ? {
          ...s,
          ...next,
          data: mergeData
            ? { ...(s.data || {}), ...(next.data || {}) }
            : next.data ?? s.data,
        }
      : s
  );
}

export function useSSE() {
  const [state, setState] = useState<SSEState>({
    isProcessing: false,
    steps: [],
    currentStep: null,
    result: null,
    resultData: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const process = useCallback(async (config: ProcessConfig) => {
    // Reset state
    setState({
      isProcessing: true,
      steps: [],
      currentStep: null,
      result: null,
      resultData: null,
      error: null,
    });

    // Build FormData
    const formData = new FormData();
    formData.append("transcript", config.transcript);
    formData.append("universeName", config.universeName);
    formData.append("universeContext", config.universeContext);
    formData.append("sessionHistory", config.sessionHistory);
    formData.append("playerInfo", JSON.stringify(config.playerInfo));

    abortRef.current = new AbortController();

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        body: formData,
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType: string | null = null;

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleEvent(eventType, data);
            } catch {
              // skip invalid JSON
            }
            eventType = null;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          error: (err as Error).message,
        }));
      }
    }
  }, []);

  const handleEvent = (type: string, data: Record<string, unknown>) => {
    switch (type) {
      case "step:scenes": {
        const group = data.group === "validator" ? "validator" : "summarizer";
        const scenes = (data.scenes as ScenePayload[]) ?? [];
        setState((prev) => {
          let nextSteps = [...prev.steps];
          for (const scene of scenes) {
            const stepId = `${group}_scene_${scene.id}`;
            const label =
              group === "validator"
                ? `Validation scène ${scene.id} : ${scene.title} (L${scene.startLine}-${scene.endLine})`
                : `Scène ${scene.id} : ${scene.title} (L${scene.startLine}-${scene.endLine})`;
            nextSteps = upsertStep(
              nextSteps,
              {
                step: stepId,
                label,
                data: {
                  sceneId: scene.id,
                  title: scene.title,
                  startLine: scene.startLine,
                  endLine: scene.endLine,
                  group,
                  status: "pending",
                },
              },
              true
            );
          }
          return { ...prev, steps: nextSteps };
        });
        break;
      }

      case "step:start": {
        const stepId = data.step as string;
        const label = data.label as string;
        const stepData = data.data as Record<string, unknown> | undefined;
        setState((prev) => {
          const steps = upsertStep(
            prev.steps,
            {
              step: stepId,
              label,
              data: {
                ...(stepData || {}),
                status: "in_progress",
              },
            },
            true
          );
          return { ...prev, currentStep: stepId, steps };
        });
        break;
      }

      case "step:complete":
        setState((prev) => {
          const stepId = data.step as string;
          const label = data.label as string;
          const stepData = data.data as Record<string, unknown> | undefined;
          const steps = upsertStep(
            prev.steps,
            {
              step: stepId,
              label,
              data: {
                ...(stepData || {}),
                status: "completed",
              },
            },
            true
          );
          return { ...prev, steps };
        });
        break;

      case "step:progress":
        setState((prev) => ({
          ...prev,
          steps: prev.steps.map((s) =>
            s.step === data.step
              ? { ...s, label: data.label as string }
              : s
          ),
        }));
        break;

      case "result":
        setState((prev) => ({
          ...prev,
          result: data.finalReport as string,
          resultData: data,
        }));
        break;

      case "error":
        setState((prev) => ({
          ...prev,
          error: data.message as string,
        }));
        break;

      case "done":
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          currentStep: null,
        }));
        break;
    }
  };

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isProcessing: false,
      currentStep: null,
    }));
  }, []);

  return { ...state, process, cancel };
}
