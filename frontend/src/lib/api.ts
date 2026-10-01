export interface Universe {
  id: string;
  label: string;
  defaultPrompt: string;
  isCustom: boolean;
}

export type CastRole = "player" | "gm" | "npc";

export interface PlayerInfo {
  playerName: string;
  characterName: string;
  /** player = joueur et son PJ (défaut), gm = meneur, npc = PNJ récurrent. */
  role?: CastRole;
  /** Autres noms du personnage, séparés par des virgules. */
  aliases?: string;
  characterDetails?: string;
}

/** Une ligne est envoyée si elle est exploitable pour son rôle. */
export function isSendablePlayer(p: PlayerInfo): boolean {
  switch (p.role ?? "player") {
    case "gm":
      return !!p.playerName.trim();
    case "npc":
      return !!p.characterName.trim();
    default:
      return !!p.playerName.trim() && !!p.characterName.trim();
  }
}

export function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(aac|m4a|mp3|wav|ogg|oga|opus|flac|webm)$/i.test(file.name);
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
  | "review"
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

export async function renameUniverse(
  universeId: string,
  label: string
): Promise<Universe> {
  const res = await fetch(`/api/universes/${encodeURIComponent(universeId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });

  if (!res.ok) {
    let errorMessage = "Failed to rename universe";
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

export async function deleteUniverse(universeId: string): Promise<void> {
  const res = await fetch(`/api/universes/${encodeURIComponent(universeId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    let errorMessage = "Failed to delete universe";
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

/**
 * Envoie un enregistrement par morceaux (requêtes courtes : pas de coupure par un proxy, reprise
 * d'un morceau en cas d'erreur). Renvoie l'identifiant d'envoi à passer à la création du job.
 */
export async function uploadInChunks(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<string> {
  const start = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size }),
  });
  const { uploadId, chunkSize } = await jsonOrThrow<{ uploadId: string; chunkSize: number }>(start);
  const total = Math.ceil(file.size / chunkSize);
  let index = 0;
  while (index < total) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(index * chunkSize, (index + 1) * chunkSize),
        });
        if (res.status === 409) {
          // Le serveur attend un autre morceau (réponse perdue) : on repart de là.
          index = ((await res.json()) as { nextIndex: number }).nextIndex;
          lastError = null;
          break;
        }
        await jsonOrThrow(res);
        index++;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    if (lastError) throw new Error(`Envoi interrompu au morceau ${index + 1}/${total} : ${(lastError as Error).message}`);
    onProgress?.(Math.min(1, index / total));
  }
  return uploadId;
}

function toProcessFormData(config: ProcessConfig, uploadId?: string): FormData {
  const formData = new FormData();
  if (uploadId) formData.append("uploadId", uploadId);
  else formData.append("transcript", config.transcript);
  formData.append("transcriptName", config.transcript.name);
  formData.append("universeName", config.universeName);
  formData.append("universeContext", config.universeContext);
  formData.append("sessionHistory", config.sessionHistory);
  formData.append("playerInfo", JSON.stringify(config.playerInfo));
  return formData;
}

export async function createProcessJob(
  config: ProcessConfig,
  onUploadProgress?: (fraction: number) => void
): Promise<ProcessJobSummary> {
  // Un enregistrement pèse des centaines de Mo : envoi par morceaux. Un transcript part d'un bloc.
  const uploadId = isAudioFile(config.transcript)
    ? await uploadInChunks(config.transcript, onUploadProgress)
    : undefined;
  const res = await fetch("/api/jobs", {
    method: "POST",
    body: toProcessFormData(config, uploadId),
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
  /** Coût Gemini de la génération (null pour les rapports d'avant le suivi des coûts). */
  cost?: { costUsd: number; calls: number } | null;
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

// ── Scene editing ────────────────────────────────────────────────────────────

export interface SceneMeta {
  id: number;
  title: string;
  type: string;
  startLine: number;
  endLine: number;
  location?: string;
  synopsis?: string | null;
  transcriptExcerpt?: string | null;
}

export interface SceneSummary {
  sceneId: number;
  narrativeSummary: string;
  keyEvents: string[];
  diceRolls: Array<{
    character: string;
    skill: string;
    result: string;
    context: string;
  }>;
  npcsInvolved: string[];
  technicalNotes?: string[];
}

export interface SceneWithSummary extends SceneMeta {
  summary: SceneSummary | null;
}

export interface UpdateSceneResult {
  reportId: string;
  sceneId: number;
  reportMd: string;
  updatedSummary?: SceneSummary;
}

export async function fetchScenes(reportId: string): Promise<SceneWithSummary[]> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/scenes`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.scenes;
}

export interface RebuildReportResult {
  reportId: string;
  reportMd: string;
}

export async function rebuildReport(
  reportId: string
): Promise<RebuildReportResult> {
  const res = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/rebuild`,
    { method: "POST" }
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

export interface RegenerateSceneResult {
  reportId: string;
  sceneId: number;
  reportMd: string;
  regeneratedSummary: SceneSummary;
}

export async function regenerateScene(
  reportId: string,
  sceneId: number,
  instruction?: string
): Promise<RegenerateSceneResult> {
  const body = instruction?.trim() ? JSON.stringify({ instruction: instruction.trim() }) : undefined;
  const res = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/scenes/${sceneId}/regenerate`,
    {
      method: "POST",
      ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}),
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

export async function updateScene(
  reportId: string,
  sceneId: number,
  narrativeSummary: string
): Promise<UpdateSceneResult> {
  const res = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/scenes/${sceneId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ narrativeSummary }),
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

// ── Revue des attributions incertaines ───────────────────────────────────────

export interface ReviewItem {
  eventId: string;
  t: number;
  start: number;
  end: number;
  actor: string;
  spokenBy: string;
  action: string;
  status: string;
  confidence: number;
  evidence: string;
  /** Pourquoi l'analyse doute (voix qui se chevauchent, désaccord diarisation/analyse…). */
  reasons: string[];
  excerpt: string[];
}

export interface ReviewDecision {
  eventId: string;
  actor?: string;
  drop?: boolean;
}

export interface PendingReview {
  nameDictionary?: NameEntry[];
  nameEvidence?: NameEvidence[];
  jobId: string;
  items: ReviewItem[];
  /** Personnages proposables comme acteur (PJ puis PNJ du casting). */
  candidates: string[];
  /** Personnes réelles à la table (pour enregistrer un échantillon de voix). */
  people: string[];
  hasAudio: boolean;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // garde le message HTTP
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export async function fetchJobReview(jobId: string): Promise<PendingReview> {
  return jsonOrThrow(await fetch(`/api/jobs/${encodeURIComponent(jobId)}/review`));
}

export async function submitJobReview(jobId: string, decisions: ReviewDecision[], nameDictionary?: NameEntry[]): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions, nameDictionary }),
    })
  );
}

export interface NameEntry {
  assignedEventIds?: string[];
  id: string;
  canonical: string;
  kind: "PJ" | "PNJ";
  status: "proposed" | "confirmed";
  aliases: { name: string; kind: "transcription" | "alias"; status: "proposed" | "confirmed" | "rejected"; reason: string; eventIds: string[] }[];
}

export interface NameEvidence { eventId: string; text: string; start: number; end: number }
export interface ReportNames { nameDictionary: NameEntry[]; evidence: NameEvidence[]; warnings?: { name: string; reason: string }[] }
export async function fetchReportNames(id: string): Promise<ReportNames> {
  return jsonOrThrow(await fetch(`/api/reports/${encodeURIComponent(id)}/names`));
}
export async function saveReportNames(id: string, nameDictionary: NameEntry[]): Promise<{ reportMd: string }> {
  return jsonOrThrow(await fetch(`/api/reports/${encodeURIComponent(id)}/names`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nameDictionary }),
  }));
}

export function jobAudioUrl(jobId: string, start: number, end: number): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/audio?start=${start.toFixed(1)}&end=${end.toFixed(1)}`;
}

// ── Échantillons de voix ─────────────────────────────────────────────────────

export interface Voiceprint {
  id: string;
  universeId: string;
  personName: string;
  durationSec: number | null;
  source: string | null;
  /** confirmed = validé (utilisé par l'analyse), pending = proposé automatiquement, à vérifier. */
  status: "confirmed" | "pending";
  createdAt: string;
}

export async function updateVoiceprint(
  id: string,
  patch: { status?: "confirmed" | "pending"; personName?: string }
): Promise<Voiceprint> {
  return jsonOrThrow(
    await fetch(`/api/voiceprints/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function listVoiceprints(universeId: string): Promise<Voiceprint[]> {
  return jsonOrThrow(await fetch(`/api/universes/${encodeURIComponent(universeId)}/voiceprints`));
}

export async function uploadVoiceprint(universeId: string, personName: string, clip: File): Promise<Voiceprint> {
  const form = new FormData();
  form.append("personName", personName);
  form.append("clip", clip);
  return jsonOrThrow(
    await fetch(`/api/universes/${encodeURIComponent(universeId)}/voiceprints`, { method: "POST", body: form })
  );
}

export async function createVoiceprintFromJob(
  jobId: string,
  personName: string,
  start: number,
  end: number
): Promise<Voiceprint> {
  return jsonOrThrow(
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/voiceprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personName, start, end }),
    })
  );
}

export async function deleteVoiceprint(id: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/voiceprints/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export function voiceprintAudioUrl(id: string): string {
  return `/api/voiceprints/${encodeURIComponent(id)}/audio`;
}
