import { Loader2, Eye, RotateCw } from "lucide-react";
import type { ProcessJobSummary } from "../lib/api";
import { formatDateTime } from "../lib/format";

interface ProcessingJobsPanelProps {
  jobs: ProcessJobSummary[];
  activeJobId: string | null;
  isFollowing: boolean;
  isViewing: boolean;
  universeLabels: Record<string, string>;
  onFollowJob: (jobId: string) => void;
}

function statusLabel(status: ProcessJobSummary["status"]): string {
  switch (status) {
    case "pending":
      return "En attente";
    case "running":
      return "En cours";
    case "review":
      return "Attend ta vérification";
    case "completed":
      return "Terminé";
    case "failed":
      return "En erreur";
    default:
      return status;
  }
}

export default function ProcessingJobsPanel({
  jobs,
  activeJobId,
  isFollowing,
  isViewing,
  universeLabels,
  onFollowJob,
}: ProcessingJobsPanelProps) {
  if (jobs.length === 0) return null;

  return (
    <section aria-labelledby="jobs-title" className="card p-5">
      <h2 id="jobs-title" className="flex items-center gap-2 text-base font-semibold text-ink">
        <Loader2 className="h-4 w-4 animate-spin text-accent-ink" aria-hidden="true" />
        Générations en cours
      </h2>

      <ul className="mt-3 space-y-2">
        {jobs.map((job) => {
          const isShown = activeJobId === job.id && isFollowing && isViewing;
          const canResume = activeJobId === job.id && !isFollowing;
          return (
            <li
              key={job.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 ${
                isShown ? "border-accent/40 bg-accent-soft/60" : "border-line bg-surface"
              }`}
            >
              <div className="min-w-[10rem] flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {universeLabels[job.universeName] ?? job.universeName}
                </p>
                <p className="truncate text-sm text-ink-muted">
                  {statusLabel(job.status)} · {formatDateTime(job.createdAt)}
                </p>
              </div>

              {isShown ? (
                <span className="shrink-0 text-sm font-medium text-accent-ink">Affichée</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onFollowJob(job.id)}
                  className="btn-secondary btn-sm shrink-0"
                >
                  {canResume ? (
                    <RotateCw className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                  {canResume ? "Reprendre le suivi" : activeJobId === job.id ? "Voir la progression" : "Suivre"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
