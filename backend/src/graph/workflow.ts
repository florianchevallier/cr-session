import { StateGraph, START, END } from "@langchain/langgraph";
import { WorkflowState, WorkflowStateType } from "./state.js";
import { preprocessTranscript } from "../tools/preprocessing.js";
import { analystNode } from "../agents/analyst.js";
import { summarizerNode } from "../agents/summarizer.js";
import { validatorNode } from "../agents/validator.js";
import { formatterNode } from "../agents/formatter.js";

const MAX_RETRIES = 2;

const log = (msg: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[cr] ${msg}${payload}`);
};

// ── Preprocessor node (pure code, no LLM) ───────────────────────────────────

function preprocessorNode(
  state: WorkflowStateType
): Partial<WorkflowStateType> {
  log("Début nœud: preprocessor", {
    inputLength: state.rawTranscript?.length ?? 0,
  });
  const { preprocessed, stats } = preprocessTranscript(state.rawTranscript);
  log("Fin nœud: preprocessor", {
    lines: stats.totalLines,
    speakers: Object.keys(stats.speakerCounts).length,
    diceRolls: stats.diceRollCount,
  });
  return {
    preprocessedTranscript: preprocessed,
    currentStep: "preprocessor_complete",
  };
}

// ── Routing: validator → formatter or → summarizer ───────────────────────────

function validatorRouter(
  state: WorkflowStateType
): "formatter" | "summarizer" {
  const issues = state.validationReport.issues;
  const errorsCount = issues.filter((i) => i.severity === "error").length;
  const warningsCount = issues.filter((i) => i.severity === "warning").length;
  const infosCount = issues.filter((i) => i.severity === "info").length;
  const hasErrors = errorsCount > 0;
  const canRetry = hasErrors && state.retryCount < MAX_RETRIES;
  const nextNode = canRetry ? "summarizer" : "formatter";
  log("Routage validator", {
    isValid: state.validationReport.isValid,
    retryCount: state.retryCount,
    maxRetries: MAX_RETRIES,
    issuesCount: issues.length,
    errorsCount,
    warningsCount,
    infosCount,
    pendingSceneIds: state.pendingSceneIds,
    canRetry,
    nextNode,
  });
  return nextNode;
}

// ── Build the workflow graph ─────────────────────────────────────────────────

export function buildWorkflow() {
  const graph = new StateGraph(WorkflowState)
    .addNode("preprocessor", preprocessorNode)
    .addNode("analyst", analystNode)
    .addNode("summarizer", summarizerNode)
    .addNode("validator", validatorNode)
    .addNode("formatter", formatterNode)
    .addEdge(START, "preprocessor")
    .addEdge("preprocessor", "analyst")
    .addEdge("analyst", "summarizer")
    .addEdge("summarizer", "validator")
    .addConditionalEdges("validator", validatorRouter, {
      formatter: "formatter",
      summarizer: "summarizer",
    })
    .addEdge("formatter", END);

  return graph.compile();
}
