import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const dataDir = resolve(__dirname, "..", "data");
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
  defaultPlayers?: Array<{
    playerName: string;
    characterName: string;
    speakerHint?: string;
  }>;
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

// ── Reports ──────────────────────────────────────────────────────────────────

export interface ReportRow {
  id: string;
  jobId: string | null;
  reportMd: string;
  universeName: string;
  transcriptName: string;
  players: Array<{ playerName: string; characterName: string; speakerHint?: string }>;
  workflowState: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSummaryRow {
  id: string;
  jobId: string | null;
  universeName: string;
  transcriptName: string;
  players: Array<{ playerName: string; characterName: string; speakerHint?: string }>;
  createdAt: string;
  updatedAt: string;
}

export function insertReport(report: {
  id: string;
  jobId?: string | null;
  reportMd: string;
  universeName: string;
  transcriptName: string;
  players: Array<{ playerName: string; characterName: string; speakerHint?: string }>;
  workflowState?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO reports (id, job_id, report_md, universe_name, transcript_name, players_json, workflow_state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    report.id,
    report.jobId ?? null,
    report.reportMd,
    report.universeName,
    report.transcriptName,
    JSON.stringify(report.players),
    report.workflowState ? JSON.stringify(report.workflowState) : null
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

// ── Migration from disk ──────────────────────────────────────────────────────

export function migrateEditorDraftsFromDisk(): void {
  const editorDraftsDir = resolve(__dirname, "..", "data", "editor-drafts");
  if (!existsSync(editorDraftsDir)) return;

  const existingCount = (
    db.prepare("SELECT COUNT(*) as count FROM editor_drafts").get() as {
      count: number;
    }
  ).count;
  if (existingCount > 0) return; // already migrated

  try {
    const files = readdirSync(editorDraftsDir).filter((f) =>
      f.endsWith(".json")
    );
    for (const file of files) {
      const universeId = file.replace(".json", "");
      const content = readFileSync(join(editorDraftsDir, file), "utf-8");
      try {
        const data = JSON.parse(content);
        upsertEditorDraft(universeId, {
          universeContext:
            typeof data.universeContext === "string"
              ? data.universeContext
              : "",
          sessionHistory:
            typeof data.sessionHistory === "string"
              ? data.sessionHistory
              : "",
          defaultPlayers: Array.isArray(data.defaultPlayers)
            ? data.defaultPlayers
            : undefined,
        });
      } catch {
        // skip invalid file
      }
    }
    if (files.length > 0) {
      console.log(
        `[db] Migrated ${files.length} editor draft(s) from disk to SQLite`
      );
    }
  } catch {
    // ignore migration errors
  }
}

export default db;
