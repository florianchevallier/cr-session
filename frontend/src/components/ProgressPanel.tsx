import type { ReactNode } from "react";
import { Loader2, Check, Circle, AlertTriangle } from "lucide-react";
import type { StepEvent } from "../hooks/useSSE";

type Status = "pending" | "in_progress" | "completed" | "interrupted";

/**
 * Étapes du traitement, dans l'ordre. `optional` : affichée seulement si le serveur l'annonce
 * (pas de transcription pour un transcript texte, pas de vérification s'il n'y a aucun doute).
 * `weight` : part approximative du temps total, pour la barre de progression.
 */
const STAGES = [
  { id: "upload", name: "Envoi de l'enregistrement", optional: true, weight: 8 },
  { id: "transcribe", name: "Transcription de l'enregistrement", optional: true, weight: 30 },
  { id: "voices", name: "Qui parle ? Identification des voix", optional: false, weight: 4 },
  { id: "ledger", name: "Écoute de la séance : qui fait quoi", optional: false, weight: 36 },
  { id: "consolidate", name: "Découpage en chapitres", optional: false, weight: 5 },
  { id: "review", name: "Ta vérification des passages douteux", optional: true, weight: 0 },
  { id: "write", name: "Rédaction et relecture des chapitres", optional: false, weight: 22 },
  { id: "format", name: "Compte-rendu prêt", optional: false, weight: 3 },
] as const;

const STATUS_TEXT: Record<Status, string> = {
  pending: "À venir",
  in_progress: "En cours",
  completed: "Terminé",
  interrupted: "Interrompu",
};

function rawStatus(step: StepEvent | undefined): "pending" | "in_progress" | "completed" {
  const raw = step?.data?.status;
  return raw === "in_progress" || raw === "completed" ? raw : "pending";
}

function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "completed":
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ok text-surface">
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      );
    case "in_progress":
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      );
    case "interrupted":
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="h-4 w-4" />
        </span>
      );
    default:
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line-strong text-ink-subtle">
          <Circle className="h-2 w-2" fill="currentColor" />
        </span>
      );
  }
}

interface ProgressPanelProps {
  steps: StepEvent[];
  error: string | null;
  isProcessing: boolean;
  /** Une vérification attend l'utilisateur : la génération est en pause. */
  awaitingReview?: boolean;
  actions?: ReactNode;
}

export default function ProgressPanel({ steps, error, isProcessing, awaitingReview = false, actions }: ProgressPanelProps) {
  const byId = new Map<string, StepEvent>();
  for (const step of steps) byId.set(step.step, step);
  const interrupted = !!error;

  const stages = STAGES.filter((stage) => !stage.optional || byId.has(stage.id)).map((stage) => {
    const step = byId.get(stage.id);
    let status: Status = rawStatus(step);
    if (status === "in_progress" && interrupted) status = "interrupted";
    if (status === "in_progress" && !isProcessing && !interrupted) status = "completed";
    return { ...stage, step, status };
  });

  const total = stages.reduce((sum, s) => sum + s.weight, 0) || 1;
  const done = stages.reduce(
    (sum, s) => sum + (s.status === "completed" ? s.weight : s.status === "pending" ? 0 : s.weight * 0.4),
    0
  );
  const percent = Math.round((done / total) * 100);

  const active = stages.find((s) => s.status === "in_progress" || s.status === "interrupted");
  const allDone = stages.every((s) => s.status === "completed");
  const summary = interrupted
    ? "Génération interrompue"
    : awaitingReview
      ? "En pause : quelques passages à vérifier"
      : allDone
        ? "Compte-rendu prêt"
        : (active?.step?.label ?? active?.name ?? "Préparation…");

  return (
    <section className="card overflow-hidden" aria-labelledby="progress-title">
      <div className="border-b border-line px-5 py-5">
        <h1 id="progress-title" className="text-xl font-semibold text-ink">
          {interrupted ? "Génération interrompue" : allDone ? "Compte-rendu prêt" : "Génération en cours"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {interrupted
            ? "La connexion a été perdue. Reprends le suivi : le travail déjà fait est conservé tant que le serveur n'a pas redémarré."
            : awaitingReview
              ? "Réponds aux questions ci-dessus : la rédaction reprend dès que tu valides."
              : "Tu peux quitter cette page, la génération continue."}
        </p>

        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-ink">{summary}</span>
            <span className="tabular-nums text-ink-muted">{percent} %</span>
          </div>
          <div
            role="progressbar"
            aria-label="Avancement de la génération"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={summary}
            className="h-2 overflow-hidden rounded-full bg-sunken"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ease-out ${interrupted ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${Math.max(percent, 2)}%` }}
            />
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {summary}
        </p>
      </div>

      <ol className="px-5 py-5">
        {stages.map((stage, index) => (
          <li key={stage.id} className="relative flex gap-4 pb-5 last:pb-0">
            {index < stages.length - 1 && (
              <span
                className={`absolute left-[13px] top-8 bottom-0 w-px ${stage.status === "completed" ? "bg-ok/50" : "bg-line-strong"}`}
                aria-hidden="true"
              />
            )}
            <StatusIcon status={stage.status} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={`text-base ${stage.status === "pending" ? "text-ink-muted" : "font-semibold text-ink"}`}>
                  {stage.name}
                </p>
                <p className={`text-sm ${stage.status === "interrupted" ? "text-danger" : "text-ink-muted"}`}>
                  {STATUS_TEXT[stage.status]}
                </p>
              </div>
              {stage.step?.label && stage.step.label !== stage.name && stage.status !== "pending" && (
                <p className="mt-0.5 text-sm text-ink-muted">{stage.step.label}</p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {(error || actions) && (
        <div className="space-y-4 border-t border-line bg-sunken/60 px-5 py-4">
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
          {actions && <div className="flex flex-col gap-2 sm:flex-row">{actions}</div>}
        </div>
      )}
    </section>
  );
}
