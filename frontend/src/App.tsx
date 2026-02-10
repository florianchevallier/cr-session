import { useState, useEffect, useRef } from "react";
import { Scroll, Sparkles, AlertCircle } from "lucide-react";
import DropZone from "./components/DropZone";
import UniverseSelector from "./components/UniverseSelector";
import PlayerForm from "./components/PlayerForm";
import ProgressPanel from "./components/ProgressPanel";
import ReportViewer from "./components/ReportViewer";
import ReportHistoryPanel from "./components/ReportHistoryPanel";
import { useSSE } from "./hooks/useSSE";
import { checkHealth } from "./lib/api";
import type { PlayerInfo, ProcessConfig } from "./lib/api";
import {
  createReportHistoryEntry,
  deleteHistoryItem,
  loadReportHistory,
  prependHistoryItem,
  saveReportHistory,
} from "./lib/reportHistory";
import type { ReportHistoryItem } from "./lib/reportHistory";

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
  const [reportHistory, setReportHistory] = useState<ReportHistoryItem[]>([]);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [historyStorageError, setHistoryStorageError] = useState<string | null>(
    null
  );
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

  // Load history from localStorage at startup.
  useEffect(() => {
    const existingHistory = loadReportHistory();
    setReportHistory(existingHistory);
    if (existingHistory.length > 0) {
      setActiveReportId(existingHistory[0].id);
    }
  }, []);

  // Persist every successful generation into local history.
  useEffect(() => {
    if (!sse.result || !sse.resultData || sse.isProcessing) return;
    if (handledResultDataRef.current === sse.resultData) return;

    handledResultDataRef.current = sse.resultData;

    const newHistoryItem = createReportHistoryEntry({
      report: sse.result,
      universeName: selectedUniverse,
      transcriptName: file?.name,
      players,
    });

    const nextHistory = prependHistoryItem(reportHistory, newHistoryItem);
    setReportHistory(nextHistory);

    try {
      saveReportHistory(nextHistory);
      setHistoryStorageError(null);
    } catch {
      setHistoryStorageError(
        "Historique non sauvegarde: espace localStorage insuffisant."
      );
    }

    setActiveReportId(newHistoryItem.id);
    setStep("result");
  }, [
    sse.result,
    sse.resultData,
    sse.isProcessing,
    selectedUniverse,
    file,
    players,
    reportHistory,
  ]);

  const activeReport = reportHistory.find((item) => item.id === activeReportId);

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
  };

  const handleOpenHistoryReport = (reportId: string) => {
    setActiveReportId(reportId);
    setStep("result");
  };

  const handleDeleteHistoryReport = (reportId: string) => {
    const nextHistory = deleteHistoryItem(reportHistory, reportId);
    setReportHistory(nextHistory);

    try {
      saveReportHistory(nextHistory);
      setHistoryStorageError(null);
    } catch {
      setHistoryStorageError(
        "Historique partiellement mis a jour: erreur d'ecriture localStorage."
      );
    }

    if (activeReportId === reportId) {
      if (nextHistory.length > 0) {
        setActiveReportId(nextHistory[0].id);
      } else {
        setActiveReportId(null);
        if (step === "result") {
          setStep("config");
        }
      }
    }
  };

  const handleClearHistory = () => {
    if (!window.confirm("Supprimer tout l'historique des comptes-rendus ?")) {
      return;
    }

    setReportHistory([]);
    setActiveReportId(null);
    if (step === "result") {
      setStep("config");
    }

    try {
      saveReportHistory([]);
      setHistoryStorageError(null);
    } catch {
      setHistoryStorageError(
        "Impossible de vider l'historique dans localStorage."
      );
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
              Configure ta <code className="rounded bg-amber-100 px-1">GOOGLE_API_KEY</code> dans le
              fichier <code className="rounded bg-amber-100 px-1">.env</code> pour utiliser Gemini.
            </p>
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
            <button onClick={handleReset} className="btn-secondary w-full justify-center">
              Retour
            </button>
          )}
        </div>
      )}

      {/* Result step */}
      {step === "result" && activeReport && (
        <div className="space-y-5">
          <ReportViewer report={activeReport.report} />

          <div className="flex justify-center pt-4">
            <button onClick={handleReset} className="btn-secondary">
              Nouvelle session
            </button>
          </div>
        </div>
      )}

      <div className="mt-5">
        <ReportHistoryPanel
          history={reportHistory}
          activeReportId={activeReportId}
          onOpenReport={handleOpenHistoryReport}
          onDeleteReport={handleDeleteHistoryReport}
          onClearHistory={handleClearHistory}
          openDisabled={sse.isProcessing}
          storageError={historyStorageError}
        />
      </div>
    </div>
  );
}
