import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Scroll, Sparkles, ArrowLeft, RotateCw } from "lucide-react";
import DropZone from "./components/DropZone";
import UniverseSelector from "./components/UniverseSelector";
import PlayerForm from "./components/PlayerForm";
import ProgressPanel from "./components/ProgressPanel";
import AttributionReview from "./components/AttributionReview";
import VoiceSamplesPanel from "./components/VoiceSamplesPanel";
import ReportViewer from "./components/ReportViewer";
import ReportHistoryPanel from "./components/ReportHistoryPanel";
import ProcessingJobsPanel from "./components/ProcessingJobsPanel";
import Notice from "./components/ui/Notice";
import { useSSE } from "./hooks/useSSE";
import {
  checkHealth,
  listProcessJobs,
  fetchReports,
  fetchReport,
  fetchUniverses,
  deleteReportApi,
  correctReport,
  isSendablePlayer,
} from "./lib/api";
import type {
  PlayerInfo,
  ProcessConfig,
  ProcessJobSummary,
  ReportSummary,
  ReportDetail,
} from "./lib/api";
import { plural } from "./lib/format";
import packageJson from "../../package.json";

type AppStep = "config" | "processing" | "result";
const APP_VERSION = packageJson.version;

function FormSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="card p-5">
      <div className="mb-4">
        <h2 id={id} className="section-title">
          {title}
        </h2>
        {description && <p className="hint mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export default function App() {
  const [step, setStep] = useState<AppStep>("config");

  // Config state
  const [file, setFile] = useState<File | null>(null);
  const [selectedUniverse, setSelectedUniverse] = useState("mage");
  const [universeContext, setUniverseContext] = useState("");
  const [sessionHistory, setSessionHistory] = useState("");
  const [players, setPlayers] = useState<PlayerInfo[]>([
    { playerName: "", characterName: "", role: "gm" },
    { playerName: "", characterName: "", role: "player" },
  ]);
  const [runningJobs, setRunningJobs] = useState<ProcessJobSummary[]>([]);
  const [universeLabels, setUniverseLabels] = useState<Record<string, string>>({});

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
      const jobs = await listProcessJobs(["pending", "running", "review"]);
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
      playerInfo: players.filter(isSendablePlayer),
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
      setReportError("Impossible de supprimer ce compte-rendu.");
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm("Supprimer tous les comptes-rendus ? Cette action est irréversible.")) {
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
      setReportError("Erreur lors de la suppression des comptes-rendus.");
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

  const handleReportUpdate = (newReport: string) => {
    setActiveReport((prev) =>
      prev ? { ...prev, reportMd: newReport } : prev
    );
  };

  // ── Universe labels (history, jobs, report header) ───────────────────────

  useEffect(() => {
    if (step !== "config" && Object.keys(universeLabels).length > 0) return;
    fetchUniverses()
      .then((list) => setUniverseLabels(Object.fromEntries(list.map((u) => [u.id, u.label]))))
      .catch(() => {
        // Labels are cosmetic: fall back to ids.
      });
    // Refetched when coming back to the form: a universe may have been added.
  }, [step]);

  // Each step starts at the top of the page (a report opened from the list
  // must not keep the list's scroll position).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step, activeReportId]);

  const playersToSend = players.filter(isSendablePlayer);
  const universeLabel = universeLabels[selectedUniverse] ?? selectedUniverse;
  const blockReason = !file
    ? "Ajoute d'abord l'enregistrement ou le transcript de la session."
    : apiReady === false
      ? "La clé API Gemini n'est pas configurée sur le serveur."
      : null;

  const visibleJobs = useMemo(
    () =>
      // The job on screen already has its own progress and actions.
      step === "processing"
        ? runningJobs.filter((job) => job.id !== sse.activeJobId)
        : runningJobs,
    [runningJobs, step, sse.activeJobId]
  );

  const sidebar = (
    <div className="space-y-5 lg:sticky lg:top-6">
      <ProcessingJobsPanel
        jobs={visibleJobs}
        activeJobId={sse.activeJobId}
        isFollowing={sse.isProcessing}
        isViewing={step === "processing"}
        universeLabels={universeLabels}
        onFollowJob={handleFollowJob}
      />
      <ReportHistoryPanel
        history={reportHistory}
        activeReportId={activeReportId}
        universeLabels={universeLabels}
        onOpenReport={handleOpenHistoryReport}
        onDeleteReport={handleDeleteHistoryReport}
        onClearHistory={handleClearHistory}
        openDisabled={sse.isProcessing}
      />
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:shadow-raised"
      >
        Aller au contenu
      </a>

      <header className="border-b border-line bg-surface/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={step === "config" ? undefined : handleReset}
            className={`-ml-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${step === "config" ? "cursor-default" : "hover:bg-sunken"}`}
            aria-label={step === "config" ? "CR Session" : "CR Session — revenir à l'accueil"}
          >
            <Scroll className="h-5 w-5 text-accent-ink" aria-hidden="true" />
            <span className="text-base font-semibold text-ink">CR Session</span>
          </button>

          {step === "config" ? (
            <span className="text-sm tabular-nums text-ink-muted">v{APP_VERSION}</span>
          ) : (
            <button type="button" onClick={handleReset} className="btn-ghost btn-sm">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Accueil
            </button>
          )}
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {(apiReady === false || reportError) && (
          <div className="mb-6 space-y-3">
            {apiReady === false && (
              <Notice tone="warn" title="Clé API manquante">
                Configure <code className="rounded bg-surface px-1 font-mono text-xs">GOOGLE_API_KEY</code> dans le
                fichier <code className="rounded bg-surface px-1 font-mono text-xs">.env</code> du serveur pour
                utiliser Gemini.
              </Notice>
            )}
            {reportError && (
              <Notice
                tone="danger"
                title={reportError}
                actions={
                  <button type="button" onClick={() => setReportError(null)} className="btn-secondary btn-sm">
                    Fermer
                  </button>
                }
              />
            )}
          </div>
        )}

        {step === "config" && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
            <div className="space-y-5">
              <h1 className="text-xl font-semibold text-ink">Nouveau compte-rendu</h1>

              <FormSection id="section-transcript" title="Enregistrement ou transcript">
                <DropZone file={file} onFileChange={setFile} />
              </FormSection>

              <FormSection id="section-universe" title="Univers">
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
                        : [
                            { playerName: "", characterName: "", role: "gm" },
                            { playerName: "", characterName: "", role: "player" },
                          ]
                    );
                  }}
                />
              </FormSection>

              <FormSection id="section-players" title="Table" description="Le MJ, les joueurs et leurs personnages, les PNJ récurrents.">
                <PlayerForm players={players} onChange={setPlayers} />
              </FormSection>

              <FormSection
                id="section-voices"
                title="Voix"
                description="Facultatif : aide à reconnaître qui parle dans l'enregistrement."
              >
                <VoiceSamplesPanel universeId={selectedUniverse} players={players} />
              </FormSection>

              <section aria-label="Lancer la génération" className="card p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-ink">
                      {file ? file.name : "Aucun fichier"}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {universeLabel} · {plural(playersToSend.filter((p) => (p.role ?? "player") === "player").length, "joueur")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleProcess}
                    disabled={!!blockReason}
                    aria-describedby="launch-hint"
                    className="btn-primary w-full sm:w-auto"
                  >
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    Générer le compte-rendu
                  </button>
                </div>
                <p id="launch-hint" className={`mt-3 text-sm ${blockReason ? "text-warn" : "text-ink-muted"}`}>
                  {blockReason ?? "La génération continue même si tu quittes la page."}
                </p>
              </section>
            </div>

            <aside aria-label="Historique et générations" className="min-w-0">{sidebar}</aside>
          </div>
        )}

        {step === "processing" && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
            <div className="min-w-0 space-y-6">
            {sse.review && <AttributionReview review={sse.review} onSubmitted={sse.clearReview} />}
            <ProgressPanel
              steps={sse.steps}
              awaitingReview={!!sse.review}
              error={sse.error}
              isProcessing={sse.isProcessing}
              actions={
                sse.error ? (
                  <>
                    {sse.activeJobId && (
                      <button
                        type="button"
                        onClick={() => handleFollowJob(sse.activeJobId!)}
                        className="btn-primary"
                      >
                        <RotateCw className="h-4 w-4" aria-hidden="true" />
                        Reprendre le suivi
                      </button>
                    )}
                    <button type="button" onClick={handleReset} className="btn-secondary">
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                      Retour à l'accueil
                    </button>
                  </>
                ) : null
              }
            />
            </div>
            <aside aria-label="Historique et générations" className="min-w-0">{sidebar}</aside>
          </div>
        )}

        {step === "result" && activeReport && (
          <ReportViewer
            report={activeReport.reportMd}
            reportId={activeReport.id}
            meta={{
              universeLabel: universeLabels[activeReport.universeName] ?? activeReport.universeName,
              createdAt: activeReport.createdAt,
              transcriptName: activeReport.transcriptName,
              costUsd: activeReport.cost?.costUsd ?? null,
            }}
            onCorrection={handleCorrection}
            isCorrecting={isCorrecting}
            onReportUpdate={handleReportUpdate}
            onNewSession={handleReset}
          />
        )}

      </main>

    </div>
  );
}
