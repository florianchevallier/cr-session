import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { PlayerDraft } from "../report/types.js";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Keep a stable data path in both dev (src/*) and prod (dist/*).
// database.ts lives in backend/src/config or backend/dist/config, so `../..` is backend/.
const backendRootDir = resolve(__dirname, "..", "..");
// CR_DATA_DIR permet de pointer vers une autre base (ex. copie de prod pour un test).
export const dataDir = process.env.CR_DATA_DIR ? resolve(process.env.CR_DATA_DIR) : resolve(backendRootDir, "data");
const dbPath = resolve(dataDir, "cr-session.sqlite");

// Ensure data directory exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db: DatabaseType = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema migrations ────────────────────────────────────────────────────────

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((row) => (row as { name: string }).name)
  );

  const migrations: Array<{ name: string; sql: string }> = [
    {
      name: "001_editor_drafts",
      sql: `
        CREATE TABLE IF NOT EXISTS editor_drafts (
          universe_id TEXT PRIMARY KEY,
          universe_context TEXT NOT NULL DEFAULT '',
          session_history TEXT NOT NULL DEFAULT '',
          default_players_json TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `,
    },
    {
      name: "002_reports",
      sql: `
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          job_id TEXT,
          report_md TEXT NOT NULL,
          universe_name TEXT NOT NULL DEFAULT 'generic',
          transcript_name TEXT NOT NULL DEFAULT 'transcript.txt',
          players_json TEXT NOT NULL DEFAULT '[]',
          workflow_state_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS report_corrections (
          id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          scene_index INTEGER,
          selected_text TEXT NOT NULL,
          instruction TEXT NOT NULL,
          previous_report_md TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `,
    },
    {
      name: "003_report_context",
      sql: `
        ALTER TABLE reports ADD COLUMN raw_transcript TEXT;
        ALTER TABLE reports ADD COLUMN preprocessed_transcript TEXT;
        ALTER TABLE reports ADD COLUMN universe_context TEXT;
        ALTER TABLE reports ADD COLUMN session_history TEXT;
      `,
    },
    {
      name: "004_voiceprints",
      sql: `
        CREATE TABLE IF NOT EXISTS voiceprints (
          id TEXT PRIMARY KEY,
          universe_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          clip_path TEXT NOT NULL,
          duration_sec REAL,
          source TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_voiceprints_universe ON voiceprints(universe_id);
      `,
    },
    {
      // Échantillons proposés automatiquement : « pending » tant que l'utilisateur ne les a pas validés.
      name: "005_voiceprint_status",
      sql: `ALTER TABLE voiceprints ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';`,
    },
  ];

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (name) VALUES (?)"
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.name);
    })();
    console.log(`[db] Migration applied: ${migration.name}`);
  }
}

runMigrations();

// ── Editor Drafts ────────────────────────────────────────────────────────────

export interface EditorDraftRow {
  universeContext: string;
  sessionHistory: string;
  defaultPlayers?: PlayerDraft[];
}

export function getEditorDraft(universeId: string): EditorDraftRow | null {
  const row = db
    .prepare("SELECT * FROM editor_drafts WHERE universe_id = ?")
    .get(universeId) as
    | {
        universe_id: string;
        universe_context: string;
        session_history: string;
        default_players_json: string | null;
      }
    | undefined;

  if (!row) return null;

  let defaultPlayers: EditorDraftRow["defaultPlayers"];
  if (row.default_players_json) {
    try {
      defaultPlayers = JSON.parse(row.default_players_json);
    } catch {
      defaultPlayers = undefined;
    }
  }

  return {
    universeContext: row.universe_context,
    sessionHistory: row.session_history,
    defaultPlayers,
  };
}

export function upsertEditorDraft(
  universeId: string,
  draft: EditorDraftRow
): void {
  const playersJson = draft.defaultPlayers
    ? JSON.stringify(draft.defaultPlayers)
    : null;

  db.prepare(
    `INSERT INTO editor_drafts (universe_id, universe_context, session_history, default_players_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(universe_id) DO UPDATE SET
       universe_context = excluded.universe_context,
       session_history = excluded.session_history,
       default_players_json = excluded.default_players_json,
       updated_at = datetime('now')`
  ).run(universeId, draft.universeContext, draft.sessionHistory, playersJson);
}

export function deleteEditorDraft(universeId: string): boolean {
  const result = db
    .prepare("DELETE FROM editor_drafts WHERE universe_id = ?")
    .run(universeId);
  return result.changes > 0;
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface ReportRow {
  id: string;
  jobId: string | null;
  reportMd: string;
  universeName: string;
  transcriptName: string;
  players: PlayerDraft[];
  workflowState: Record<string, unknown> | null;
  rawTranscript: string | null;
  preprocessedTranscript: string | null;
  universeContext: string | null;
  sessionHistory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSummaryRow {
  id: string;
  jobId: string | null;
  universeName: string;
  transcriptName: string;
  players: PlayerDraft[];
  createdAt: string;
  updatedAt: string;
}

export function insertReport(report: {
  id: string;
  jobId?: string | null;
  reportMd: string;
  universeName: string;
  transcriptName: string;
  players: PlayerDraft[];
  workflowState?: Record<string, unknown> | null;
  rawTranscript?: string | null;
  preprocessedTranscript?: string | null;
  universeContext?: string | null;
  sessionHistory?: string | null;
}): void {
  db.prepare(
    `INSERT INTO reports (id, job_id, report_md, universe_name, transcript_name, players_json, workflow_state_json, raw_transcript, preprocessed_transcript, universe_context, session_history, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    report.id,
    report.jobId ?? null,
    report.reportMd,
    report.universeName,
    report.transcriptName,
    JSON.stringify(report.players),
    report.workflowState ? JSON.stringify(report.workflowState) : null,
    report.rawTranscript ?? null,
    report.preprocessedTranscript ?? null,
    report.universeContext ?? null,
    report.sessionHistory ?? null
  );
}

export function updateReportMd(reportId: string, reportMd: string): void {
  db.prepare(
    `UPDATE reports SET report_md = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(reportMd, reportId);
}

export function updateReportWorkflowState(
  reportId: string,
  workflowState: Record<string, unknown>
): void {
  db.prepare(
    `UPDATE reports SET workflow_state_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(workflowState), reportId);
}

export function getReport(reportId: string): ReportRow | null {
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as
    | {
        id: string;
        job_id: string | null;
        report_md: string;
        universe_name: string;
        transcript_name: string;
        players_json: string;
        workflow_state_json: string | null;
        raw_transcript: string | null;
        preprocessed_transcript: string | null;
        universe_context: string | null;
        session_history: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;

  let players: ReportRow["players"] = [];
  try {
    players = JSON.parse(row.players_json);
  } catch {
    // ignore
  }

  let workflowState: Record<string, unknown> | null = null;
  if (row.workflow_state_json) {
    try {
      workflowState = JSON.parse(row.workflow_state_json);
    } catch {
      // ignore
    }
  }

  return {
    id: row.id,
    jobId: row.job_id,
    reportMd: row.report_md,
    universeName: row.universe_name,
    transcriptName: row.transcript_name,
    players,
    workflowState,
    rawTranscript: row.raw_transcript,
    preprocessedTranscript: row.preprocessed_transcript,
    universeContext: row.universe_context,
    sessionHistory: row.session_history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listReports(): ReportSummaryRow[] {
  const rows = db
    .prepare(
      "SELECT id, job_id, universe_name, transcript_name, players_json, created_at, updated_at FROM reports ORDER BY created_at DESC"
    )
    .all() as Array<{
    id: string;
    job_id: string | null;
    universe_name: string;
    transcript_name: string;
    players_json: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => {
    let players: ReportSummaryRow["players"] = [];
    try {
      players = JSON.parse(row.players_json);
    } catch {
      // ignore
    }
    return {
      id: row.id,
      jobId: row.job_id,
      universeName: row.universe_name,
      transcriptName: row.transcript_name,
      players,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function deleteReport(reportId: string): boolean {
  const result = db
    .prepare("DELETE FROM reports WHERE id = ?")
    .run(reportId);
  return result.changes > 0;
}

// ── Report Corrections ───────────────────────────────────────────────────────

export interface CorrectionRow {
  id: string;
  reportId: string;
  sceneIndex: number | null;
  selectedText: string;
  instruction: string;
  previousReportMd: string | null;
  createdAt: string;
}

export function insertCorrection(correction: {
  id: string;
  reportId: string;
  sceneIndex?: number | null;
  selectedText: string;
  instruction: string;
  previousReportMd?: string | null;
}): void {
  db.prepare(
    `INSERT INTO report_corrections (id, report_id, scene_index, selected_text, instruction, previous_report_md, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    correction.id,
    correction.reportId,
    correction.sceneIndex ?? null,
    correction.selectedText,
    correction.instruction,
    correction.previousReportMd ?? null
  );
}

export function listCorrections(reportId: string): CorrectionRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM report_corrections WHERE report_id = ? ORDER BY created_at ASC"
    )
    .all(reportId) as Array<{
    id: string;
    report_id: string;
    scene_index: number | null;
    selected_text: string;
    instruction: string;
    previous_report_md: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    reportId: row.report_id,
    sceneIndex: row.scene_index,
    selectedText: row.selected_text,
    instruction: row.instruction,
    previousReportMd: row.previous_report_md,
    createdAt: row.created_at,
  }));
}

// ── Voiceprints (échantillons de voix des joueurs et du MJ) ──────────────────

export interface VoiceprintRow {
  id: string;
  universeId: string;
  personName: string;
  clipPath: string;
  durationSec: number | null;
  source: string | null;
  /** confirmed = validé par l'utilisateur (utilisé par l'analyse), pending = proposé, à vérifier. */
  status: VoiceprintStatus;
  createdAt: string;
}

export type VoiceprintStatus = "confirmed" | "pending";

type VoiceprintDbRow = {
  id: string;
  universe_id: string;
  person_name: string;
  clip_path: string;
  duration_sec: number | null;
  source: string | null;
  status: string;
  created_at: string;
};

const toVoiceprint = (r: VoiceprintDbRow): VoiceprintRow => ({
  id: r.id,
  universeId: r.universe_id,
  personName: r.person_name,
  clipPath: r.clip_path,
  durationSec: r.duration_sec,
  source: r.source,
  status: r.status === "pending" ? "pending" : "confirmed",
  createdAt: r.created_at,
});

export function insertVoiceprint(v: Omit<VoiceprintRow, "createdAt" | "status"> & { status?: VoiceprintStatus }): void {
  db.prepare(
    `INSERT INTO voiceprints (id, universe_id, person_name, clip_path, duration_sec, source, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(v.id, v.universeId, v.personName, v.clipPath, v.durationSec, v.source, v.status ?? "confirmed");
}

export function updateVoiceprint(id: string, patch: { status?: VoiceprintStatus; personName?: string }): boolean {
  const current = getVoiceprint(id);
  if (!current) return false;
  db.prepare("UPDATE voiceprints SET status = ?, person_name = ? WHERE id = ?").run(
    patch.status ?? current.status,
    patch.personName?.trim() || current.personName,
    id
  );
  return true;
}

export function listVoiceprints(universeId: string): VoiceprintRow[] {
  return (
    db
      .prepare("SELECT * FROM voiceprints WHERE universe_id = ? ORDER BY person_name, created_at DESC")
      .all(universeId) as VoiceprintDbRow[]
  ).map(toVoiceprint);
}

export function getVoiceprint(id: string): VoiceprintRow | null {
  const row = db.prepare("SELECT * FROM voiceprints WHERE id = ?").get(id) as VoiceprintDbRow | undefined;
  return row ? toVoiceprint(row) : null;
}

export function deleteVoiceprint(id: string): boolean {
  return db.prepare("DELETE FROM voiceprints WHERE id = ?").run(id).changes > 0;
}
