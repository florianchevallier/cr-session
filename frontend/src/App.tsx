import { useState, useEffect, useRef, useCallback } from "react";
import { Scroll, Sparkles, AlertCircle } from "lucide-react";
import DropZone from "./components/DropZone";
import UniverseSelector from "./components/UniverseSelector";
import PlayerForm from "./components/PlayerForm";
import ProgressPanel from "./components/ProgressPanel";
import ReportViewer from "./components/ReportViewer";
import ReportHistoryPanel from "./components/ReportHistoryPanel";
import ProcessingJobsPanel from "./components/ProcessingJobsPanel";
import { useSSE } from "./hooks/useSSE";
import {
  checkHealth,
  listProcessJobs,
  fetchReports,
  fetchReport,
  deleteReportApi,
  correctReport,
} from "./lib/api";
import type {
  PlayerInfo,
  ProcessConfig,
  ProcessJobSummary,
  ReportSummary,
  ReportDetail,
} from "./lib/api";

type AppStep = "config" | "processing" | "result";

export default function App() {
  const [step, setStep] = useState<AppStep>("config");

  // Config state
  const [file, setFile] = useState<File | null>(null);
  const [selectedUniverse, setSelectedUniverse] = useState("mage");
  const [universeContext, setUniverseContext] = useState("");
  const [sessionHistory, setSessionHistory] = useState("");
  const [players, setPlayers] = useState<PlayerInfo[]>([
    { playerName: "", characterName: "", speakerHint: "" },
  ]);
  const [runningJobs, setRunningJobs] = useState<ProcessJobSummary[]>([]);

  // Report state (SQLite-backed)
  const [reportHistory, setReportHistory] = useState<ReportSummary[]>([]);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<ReportDetail | null>(null);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const handledResultDataRef = useRef<Record<string, unknown> | null>(null);

  // Health
  const [apiReady, setApiReady] = useState<boolean | null>(null);

  // SSE
  const sse = useSSE();

  useEffect(() => {
    checkHealth()
      .then((h) => setApiReady(h.hasApiKey))
      .catch(() => setApiReady(false));
  }, []);

  // ── Load reports from API ──────────────────────────────────────────────────

  const refreshReportHistory = useCallback(async () => {
    try {
      const reports = await fetchReports();
      setReportHistory(reports);
    } catch {
      // Ignore transient errors
    }
  }, []);

  useEffect(() => {
    void refreshReportHistory();
  }, [refreshReportHistory]);

  // ── Running jobs polling ───────────────────────────────────────────────────

  const refreshRunningJobs = useCallback(async () => {
    try {
      const jobs = await listProcessJobs(["pending", "running"]);
      setRunningJobs(jobs);
    } catch {
      // Ignore transient API errors
    }
  }, []);

  useEffect(() => {
    void refreshRunningJobs();
    const intervalId = window.setInterval(() => {
      void refreshRunningJobs();
    }, 5000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshRunningJobs]);

  useEffect(() => {
    if (sse.activeJobId) {
      setStep("processing");
    }
  }, [sse.activeJobId]);

  useEffect(() => {
    void refreshRunningJobs();
  }, [refreshRunningJobs, sse.activeJobId, sse.isProcessing]);

  // ── Handle SSE result → refresh reports ────────────────────────────────────

  useEffect(() => {
    if (!sse.result || !sse.resultData || sse.isProcessing) return;
    if (handledResultDataRef.current === sse.resultData) return;

    handledResultDataRef.current = sse.resultData;

    // The report was already saved to SQLite by the backend.
    // We just need to refresh the history and show the result.
    const reportId = sse.resultData.reportId as string | undefined;

    void refreshReportHistory().then(async () => {
      if (reportId) {
        try {
          const detail = await fetchReport(reportId);
          setActiveReport(detail);
          setActiveReportId(reportId);
        } catch {
          // Fallback: use the result from SSE
          setActiveReport(null);
          setActiveReportId(null);
        }
      }
      setStep("result");
    });
  }, [sse.result, sse.resultData, sse.isProcessing, refreshReportHistory]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleProcess = async () => {
    if (!file) return;

    setStep("processing");

    const config: ProcessConfig = {
      transcript: file,
      universeName: selectedUniverse,
      universeContext,
      sessionHistory,
      playerInfo: players.filter(
        (p) => p.playerName.trim() && p.characterName.trim()
      ),
    };

    await sse.process(config);
  };

  const handleReset = () => {
    setStep("config");
    setActiveReport(null);
  };

  const handleOpenHistoryReport = async (reportId: string) => {
    try {
      const detail = await fetchReport(reportId);
      setActiveReport(detail);
      setActiveReportId(reportId);
      setStep("result");
    } catch {
      setReportError("Impossible de charger ce rapport.");
    }
  };

  const handleFollowJob = (jobId: string) => {
    setStep("processing");
    void sse.followJob(jobId);
  };

  const handleDeleteHistoryReport = async (reportId: string) => {
    try {
      await deleteReportApi(reportId);
      await refreshReportHistory();

      if (activeReportId === reportId) {
        setActiveReportId(null);
        setActiveReport(null);
        if (step === "result") {
          setStep("config");
        }
      }
    } catch {
      setReportError("Impossible de supprimer ce rapport.");
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm("Supprimer tout l'historique des comptes-rendus ?")) {
      return;
    }

    try {
      // Delete all reports one by one
      for (const report of reportHistory) {
        await deleteReportApi(report.id);
      }
      await refreshReportHistory();
      setActiveReportId(null);
      setActiveReport(null);
      if (step === "result") {
        setStep("config");
      }
    } catch {
      setReportError("Erreur lors de la suppression de l'historique.");
    }
  };

  const handleCorrection = async (
    selectedText: string,
    instruction: string
  ) => {
    if (!activeReportId) return;
    setIsCorrecting(true);
    setReportError(null);

    try {
      const result = await correctReport(
        activeReportId,
        selectedText,
        instruction
      );
      // Update the active report with the corrected content
      setActiveReport((prev) =>
        prev ? { ...prev, reportMd: result.reportMd } : prev
      );
    } catch (err) {
      setReportError(
        err instanceof Error ? err.message : "Erreur lors de la correction."
      );
    } finally {
      setIsCorrecting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      {/* Header */}
      <header className="mb-10 text-center">
        <div className="mb-3 flex items-center justify-center gap-3">
          <Scroll className="h-8 w-8 text-parchment-600" />
          <h1 className="text-3xl font-bold tracking-tight text-parchment-900">
            CR Session
          </h1>
        </div>
        <p className="text-sm text-parchment-500">
          Transforme tes transcripts de JDR en comptes-rendus narratifs
        </p>
      </header>

      {/* API warning */}
      {apiReady === false && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Clef API manquante</p>
            <p className="text-xs mt-0.5">
              Configure ta{" "}
              <code className="rounded bg-amber-100 px-1">GOOGLE_API_KEY</code>{" "}
              dans le fichier{" "}
              <code className="rounded bg-amber-100 px-1">.env</code> pour
              utiliser Gemini.
            </p>
          </div>
        </div>
      )}

      {/* Report error */}
      {reportError && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p>{reportError}</p>
            <button
              onClick={() => setReportError(null)}
              className="mt-1 text-xs underline"
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Config step */}
      {step === "config" && (
        <div className="space-y-5">
          <DropZone file={file} onFileChange={setFile} />
          <UniverseSelector
            selectedUniverse={selectedUniverse}
            universeContext={universeContext}
            sessionHistory={sessionHistory}
            players={players}
            onUniverseChange={setSelectedUniverse}
            onContextChange={setUniverseContext}
            onSessionHistoryChange={setSessionHistory}
            onDefaultPlayersChange={(defaultPlayers) => {
              setPlayers(
                defaultPlayers.length > 0
                  ? defaultPlayers
                  : [{ playerName: "", characterName: "", speakerHint: "" }]
              );
            }}
          />
          <PlayerForm players={players} onChange={setPlayers} />

          {/* Submit */}
          <div className="pt-2">
            <button
              onClick={handleProcess}
              disabled={!file || apiReady === false}
              className="btn-primary w-full justify-center text-base"
            >
              <Sparkles className="h-4 w-4" />
              Générer le compte-rendu
            </button>
          </div>
        </div>
      )}

      {/* Processing step */}
      {step === "processing" && (
        <div className="space-y-5">
          <ProgressPanel
            steps={sse.steps}
            currentStep={sse.currentStep}
            error={sse.error}
            isProcessing={sse.isProcessing}
          />

          {sse.error && (
            <button
              onClick={handleReset}
              className="btn-secondary w-full justify-center"
            >
              Retour
            </button>
          )}
        </div>
      )}

      {/* Result step */}
      {step === "result" && activeReport && (
        <div className="space-y-5">
          <ReportViewer
            report={activeReport.reportMd}
            reportId={activeReport.id}
            onCorrection={handleCorrection}
            isCorrecting={isCorrecting}
          />

          <div className="flex justify-center pt-4">
            <button onClick={handleReset} className="btn-secondary">
              Nouvelle session
            </button>
          </div>
        </div>
      )}

      {/* Fallback: SSE result without reportId (old flow) */}
      {step === "result" && !activeReport && sse.result && (
        <div className="space-y-5">
          <ReportViewer report={sse.result} />

          <div className="flex justify-center pt-4">
            <button onClick={handleReset} className="btn-secondary">
              Nouvelle session
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-5">
        <ProcessingJobsPanel
          jobs={runningJobs}
          activeJobId={sse.activeJobId}
          onFollowJob={handleFollowJob}
        />
        <ReportHistoryPanel
          history={reportHistory}
          activeReportId={activeReportId}
          onOpenReport={handleOpenHistoryReport}
          onDeleteReport={handleDeleteHistoryReport}
          onClearHistory={handleClearHistory}
          openDisabled={sse.isProcessing}
          storageError={reportError}
        />
      </div>
    </div>
  );
}
