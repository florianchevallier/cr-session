import { useState, useCallback, useRef, useEffect } from "react";
import { createProcessJob } from "../lib/api";
import type { ProcessConfig } from "../lib/api";

export interface StepEvent {
  step: string;
  label: string;
  data?: Record<string, unknown>;
}

export interface SSEState {
  activeJobId: string | null;
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

const ACTIVE_JOB_STORAGE_KEY = "cr-session.active-job-id.v1";

function saveActiveJobId(jobId: string | null): void {
  if (typeof window === "undefined") return;
  if (!jobId) {
    window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
}

function loadActiveJobId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
  return value && value.trim() ? value.trim() : null;
}

export function useSSE() {
  const [state, setState] = useState<SSEState>({
    activeJobId: null,
    isProcessing: false,
    steps: [],
    currentStep: null,
    result: null,
    resultData: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const connectionRef = useRef(0);

  const handleEvent = useCallback((type: string, data: Record<string, unknown>) => {
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
        saveActiveJobId(null);
        setState((prev) => ({
          ...prev,
          activeJobId: null,
          isProcessing: false,
          currentStep: null,
          error: data.message as string,
        }));
        break;

      case "done":
        saveActiveJobId(null);
        setState((prev) => ({
          ...prev,
          activeJobId: null,
          isProcessing: false,
          currentStep: null,
        }));
        break;
    }
  }, []);

  const followJob = useCallback(
    async (jobId: string) => {
      const nextConnectionId = ++connectionRef.current;
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      saveActiveJobId(jobId);

      setState({
        activeJobId: jobId,
        isProcessing: true,
        steps: [],
        currentStep: null,
        result: null,
        resultData: null,
        error: null,
      });

      let terminalEventReceived = false;

      try {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(jobId)}/stream`,
          {
            method: "GET",
            signal: abortRef.current.signal,
          }
        );

        if (response.status === 404) {
          throw new Error("JOB_NOT_FOUND");
        }

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType: string | null = null;
        let dataBuffer: string[] = [];

        const flushEvent = () => {
          if (!eventType) return;
          if (dataBuffer.length === 0) {
            eventType = null;
            return;
          }
          try {
            const rawPayload = dataBuffer.join("\n");
            const parsed: unknown = JSON.parse(rawPayload);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              handleEvent(eventType, parsed as Record<string, unknown>);
              if (eventType === "done" || eventType === "error") {
                terminalEventReceived = true;
              }
            }
          } catch {
            // ignore invalid payloads
          } finally {
            eventType = null;
            dataBuffer = [];
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line) {
              flushEvent();
              continue;
            }

            if (line.startsWith(":")) {
              continue;
            }

            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
              continue;
            }

            if (line.startsWith("data:")) {
              dataBuffer.push(line.slice(5).trimStart());
              continue;
            }
          }
        }

        flushEvent();

        if (!terminalEventReceived && nextConnectionId === connectionRef.current) {
          setState((prev) => ({
            ...prev,
            isProcessing: false,
            currentStep: null,
            error:
              prev.error ||
              "Connexion au job interrompue. Clique sur \"Suivre\" pour reprendre.",
          }));
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (nextConnectionId !== connectionRef.current) return;

        if ((err as Error).message === "JOB_NOT_FOUND") {
          saveActiveJobId(null);
          setState((prev) => ({
            ...prev,
            activeJobId: null,
            isProcessing: false,
            currentStep: null,
            error: "Ce job n'est plus disponible (backend redémarré ou job expiré).",
          }));
          return;
        }

        setState((prev) => ({
          ...prev,
          isProcessing: false,
          currentStep: null,
          error: (err as Error).message,
        }));
      }
    },
    [handleEvent]
  );

  const process = useCallback(
    async (config: ProcessConfig) => {
      abortRef.current?.abort();
      saveActiveJobId(null);
      setState({
        activeJobId: null,
        isProcessing: true,
        steps: [],
        currentStep: null,
        result: null,
        resultData: null,
        error: null,
      });

      try {
        const job = await createProcessJob(config);
        await followJob(job.id);
      } catch (err) {
        saveActiveJobId(null);
        setState((prev) => ({
          ...prev,
          activeJobId: null,
          isProcessing: false,
          currentStep: null,
          error: (err as Error).message,
        }));
      }
    },
    [followJob]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isProcessing: false,
      currentStep: null,
    }));
  }, []);

  useEffect(() => {
    const persistedJobId = loadActiveJobId();
    if (persistedJobId) {
      void followJob(persistedJobId);
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [followJob]);

  return { ...state, process, followJob, cancel };
}
