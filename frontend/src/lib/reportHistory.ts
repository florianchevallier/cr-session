import type { PlayerInfo } from "./api";

const REPORT_HISTORY_STORAGE_KEY = "cr-session.report-history.v1";
const MAX_HISTORY_ITEMS = 30;

export interface ReportHistoryItem {
  id: string;
  createdAt: string;
  report: string;
  universeName: string;
  transcriptName: string;
  players: string[];
}

interface CreateReportHistoryEntryInput {
  report: string;
  universeName: string;
  transcriptName?: string;
  players: PlayerInfo[];
}

function createHistoryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isReportHistoryItem(value: unknown): value is ReportHistoryItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<ReportHistoryItem>;
  return (
    typeof item.id === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.report === "string" &&
    typeof item.universeName === "string" &&
    typeof item.transcriptName === "string" &&
    Array.isArray(item.players) &&
    item.players.every((p) => typeof p === "string")
  );
}

export function loadReportHistory(): ReportHistoryItem[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(REPORT_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(isReportHistoryItem)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  } catch {
    return [];
  }
}

export function saveReportHistory(items: ReportHistoryItem[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    REPORT_HISTORY_STORAGE_KEY,
    JSON.stringify(items)
  );
}

export function createReportHistoryEntry(
  input: CreateReportHistoryEntryInput
): ReportHistoryItem {
  const players = input.players
    .filter((p) => p.playerName.trim() && p.characterName.trim())
    .map((p) => `${p.playerName.trim()} (${p.characterName.trim()})`);

  return {
    id: createHistoryId(),
    createdAt: new Date().toISOString(),
    report: input.report,
    universeName: input.universeName,
    transcriptName: input.transcriptName?.trim() || "transcript.txt",
    players,
  };
}

export function prependHistoryItem(
  history: ReportHistoryItem[],
  item: ReportHistoryItem
): ReportHistoryItem[] {
  return [item, ...history].slice(0, MAX_HISTORY_ITEMS);
}

export function deleteHistoryItem(
  history: ReportHistoryItem[],
  itemId: string
): ReportHistoryItem[] {
  return history.filter((item) => item.id !== itemId);
}
