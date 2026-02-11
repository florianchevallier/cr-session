import { Activity, Clock3, Eye } from "lucide-react";
import type { ProcessJobSummary } from "../lib/api";

interface ProcessingJobsPanelProps {
  jobs: ProcessJobSummary[];
  activeJobId: string | null;
  onFollowJob: (jobId: string) => void;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function statusLabel(status: ProcessJobSummary["status"]): string {
  switch (status) {
    case "pending":
      return "En attente";
    case "running":
      return "En cours";
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
  onFollowJob,
}: ProcessingJobsPanelProps) {
  if (jobs.length === 0) return null;

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-parchment-600" />
        <h3 className="text-sm font-semibold text-parchment-900">
          Jobs de traitement en cours
        </h3>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => {
          const isActive = activeJobId === job.id;
          return (
            <div
              key={job.id}
              className={`rounded-lg border px-3 py-2.5 transition-colors ${
                isActive
                  ? "border-parchment-500 bg-parchment-50"
                  : "border-parchment-200 bg-white"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-parchment-900">
                    {job.universeName} - {job.transcriptName}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-parchment-500">
                    <span className="inline-flex items-center rounded-full bg-parchment-100 px-2 py-0.5 text-parchment-700">
                      {statusLabel(job.status)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatDate(job.createdAt)}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onFollowJob(job.id)}
                  className="btn-secondary px-2.5 py-1.5 text-xs"
                  disabled={isActive}
                >
                  <Eye className="h-3.5 w-3.5" />
                  {isActive ? "Suivi en cours" : "Suivre"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
