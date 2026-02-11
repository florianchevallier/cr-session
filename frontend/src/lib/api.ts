export interface Universe {
  id: string;
  label: string;
  defaultPrompt: string;
}

export interface PlayerInfo {
  playerName: string;
  characterName: string;
  speakerHint?: string;
}

export interface ProcessConfig {
  transcript: File;
  universeName: string;
  universeContext: string;
  sessionHistory: string;
  playerInfo: PlayerInfo[];
}

export type ProcessJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface ProcessJobSummary {
  id: string;
  status: ProcessJobStatus;
  createdAt: string;
  updatedAt: string;
  transcriptName: string;
  universeName: string;
  playersCount: number;
  error: string | null;
}

interface CreateUniverseInput {
  label: string;
  defaultPrompt: string;
}

export async function fetchUniverses(): Promise<Universe[]> {
  const res = await fetch("/api/universes");
  if (!res.ok) throw new Error("Failed to fetch universes");
  return res.json();
}

export async function createUniverse(
  input: CreateUniverseInput
): Promise<Universe> {
  const res = await fetch("/api/universes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    let errorMessage = "Failed to create universe";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) {
        errorMessage = body.message;
      }
    } catch {
      // Ignore JSON parse errors and keep default message.
    }
    throw new Error(errorMessage);
  }

  return res.json();
}

export interface UniverseDraft {
  universeContext: string;
  sessionHistory: string;
  defaultPlayers?: PlayerInfo[];
}

export async function fetchUniverseDraft(
  universeId: string
): Promise<UniverseDraft | null> {
  const res = await fetch(`/api/universes/${encodeURIComponent(universeId)}/draft`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch draft");
  return res.json();
}

export async function saveUniverseDraft(
  universeId: string,
  draft: UniverseDraft
): Promise<void> {
  const res = await fetch(
    `/api/universes/${encodeURIComponent(universeId)}/draft`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }
  );
  if (!res.ok) throw new Error("Failed to save draft");
}

export async function checkHealth(): Promise<{ status: string; hasApiKey: boolean }> {
  const res = await fetch("/api/health");
  return res.json();
}

function toProcessFormData(config: ProcessConfig): FormData {
  const formData = new FormData();
  formData.append("transcript", config.transcript);
  formData.append("transcriptName", config.transcript.name);
  formData.append("universeName", config.universeName);
  formData.append("universeContext", config.universeContext);
  formData.append("sessionHistory", config.sessionHistory);
  formData.append("playerInfo", JSON.stringify(config.playerInfo));
  return formData;
}

export async function createProcessJob(
  config: ProcessConfig
): Promise<ProcessJobSummary> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    body: toProcessFormData(config),
  });
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) {
        errorMessage = body.message;
      }
    } catch {
      // no-op
    }
    throw new Error(errorMessage);
  }
  return res.json();
}

export async function listProcessJobs(
  statuses?: ProcessJobStatus[]
): Promise<ProcessJobSummary[]> {
  const query =
    statuses && statuses.length > 0
      ? `?status=${encodeURIComponent(statuses.join(","))}`
      : "";
  const res = await fetch(`/api/jobs${query}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchProcessJob(jobId: string): Promise<ProcessJobSummary> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

// ── Reports (SQLite-backed) ──────────────────────────────────────────────────

export interface ReportSummary {
  id: string;
  jobId: string | null;
  universeName: string;
  transcriptName: string;
  players: PlayerInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface ReportDetail {
  id: string;
  jobId: string | null;
  reportMd: string;
  universeName: string;
  transcriptName: string;
  players: PlayerInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionResult {
  reportId: string;
  correctionId: string;
  reportMd: string;
}

export async function fetchReports(): Promise<ReportSummary[]> {
  const res = await fetch("/api/reports");
  if (!res.ok) throw new Error("Failed to fetch reports");
  return res.json();
}

export async function fetchReport(reportId: string): Promise<ReportDetail> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteReportApi(reportId: string): Promise<void> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function correctReport(
  reportId: string,
  selectedText: string,
  instruction: string
): Promise<CorrectionResult> {
  const res = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/correct`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedText, instruction }),
    }
  );
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) errorMessage = body.message;
    } catch {
      // no-op
    }
    throw new Error(errorMessage);
  }
  return res.json();
}
