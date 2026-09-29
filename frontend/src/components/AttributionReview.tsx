import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, Mic, UserCheck } from "lucide-react";
import Notice from "./ui/Notice";
import {
  createVoiceprintFromJob,
  jobAudioUrl,
  submitJobReview,
  type PendingReview,
  type ReviewDecision,
  type ReviewItem,
} from "../lib/api";

interface AttributionReviewProps {
  review: PendingReview;
  onSubmitted: () => void;
}

const KEEP = "__keep__";
const DROP = "__drop__";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function ReviewRow({
  item,
  review,
  choice,
  onChoice,
}: {
  item: ReviewItem;
  review: PendingReview;
  choice: string;
  onChoice: (value: string) => void;
}) {
  const id = useId();
  const [showExcerpt, setShowExcerpt] = useState(false);
  const [voicePerson, setVoicePerson] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const options = useMemo(
    () => [...new Set([item.actor, ...review.candidates].filter(Boolean))],
    [item.actor, review.candidates]
  );

  const saveVoice = async () => {
    if (!voicePerson) return;
    setVoiceStatus("Enregistrement…");
    try {
      await createVoiceprintFromJob(review.jobId, voicePerson, item.start, item.end);
      setVoiceStatus(`Échantillon de voix enregistré pour ${voicePerson}.`);
    } catch (err) {
      setVoiceStatus((err as Error).message);
    }
  };

  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink-muted">
          <span className="font-mono">{clock(item.t)}</span>
          {item.spokenBy ? ` · voix entendue : ${item.spokenBy}` : ""}
        </p>
        <span className="chip">{item.status.replace("_", " ")}</span>
      </div>
      <p className="mt-2 text-base text-ink">
        <strong>{item.actor}</strong> — {item.action}
      </p>
      {item.reasons.length > 0 && (
        <p className="mt-1 text-sm text-warn">Doute : {item.reasons.join(" ; ")}.</p>
      )}
      {item.evidence && <p className="mt-1 text-sm italic text-ink-muted">{item.evidence}</p>}

      {review.hasAudio && (
        <audio
          controls
          preload="none"
          src={jobAudioUrl(review.jobId, item.start, item.end)}
          className="mt-3 w-full"
          aria-label={`Extrait audio à ${clock(item.t)}`}
        />
      )}

      <button
        type="button"
        onClick={() => setShowExcerpt((v) => !v)}
        className="btn-ghost btn-sm mt-2"
        aria-expanded={showExcerpt}
        aria-controls={`${id}-excerpt`}
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${showExcerpt ? "rotate-180" : ""}`} aria-hidden="true" />
        Transcript de l'extrait
      </button>
      {showExcerpt && (
        <ul id={`${id}-excerpt`} className="mt-2 space-y-1 border-l-2 border-line-strong pl-3 text-sm text-ink-muted">
          {item.excerpt.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-who`} className="label">
            Qui agit vraiment ?
          </label>
          <select id={`${id}-who`} value={choice} onChange={(e) => onChoice(e.target.value)} className="input">
            <option value={KEEP}>C'est bien {item.actor}</option>
            {options
              .filter((o) => o !== item.actor)
              .map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            <option value={DROP}>Personne : à retirer du compte-rendu</option>
          </select>
        </div>
        {review.hasAudio && review.people.length > 0 && (
          <div>
            <label htmlFor={`${id}-voice`} className="label">
              Cet extrait est la voix de…{" "}
              <span className="font-normal text-ink-muted">(facultatif)</span>
            </label>
            <div className="flex gap-2">
              <select
                id={`${id}-voice`}
                value={voicePerson}
                onChange={(e) => setVoicePerson(e.target.value)}
                className="input"
              >
                <option value="">—</option>
                {review.people.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={saveVoice}
                disabled={!voicePerson}
                className="btn-secondary btn-sm shrink-0"
                title="Enregistrer comme échantillon de voix pour les prochaines séances"
              >
                <Mic className="h-4 w-4" aria-hidden="true" />
                Garder
              </button>
            </div>
            {voiceStatus && <p className="hint mt-1 text-xs">{voiceStatus}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

export default function AttributionReview({ review, onSubmitted }: AttributionReviewProps) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decisions: ReviewDecision[] = review.items
    .map((item) => ({ item, choice: choices[item.eventId] ?? KEEP }))
    .filter(({ choice }) => choice !== KEEP)
    .map(({ item, choice }) => (choice === DROP ? { eventId: item.eventId, drop: true } : { eventId: item.eventId, actor: choice }));

  const submit = async (list: ReviewDecision[]) => {
    setSubmitting(true);
    setError(null);
    try {
      await submitJobReview(review.jobId, list);
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="review-title" className="card space-y-4 p-5">
      <div>
        <h2 id="review-title" className="text-lg font-semibold text-ink">
          Qui a fait quoi ? {review.items.length} passage{review.items.length > 1 ? "s" : ""} à confirmer
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          L'analyse hésite sur ces actions. {review.hasAudio ? "Écoute l'extrait, " : "Lis l'extrait, "}
          corrige l'acteur si besoin, puis lance la rédaction. Ce que tu ne touches pas reste tel quel.
        </p>
      </div>

      <ol className="space-y-3">
        {review.items.map((item) => (
          <ReviewRow
            key={item.eventId}
            item={item}
            review={review}
            choice={choices[item.eventId] ?? KEEP}
            onChoice={(value) => setChoices((prev) => ({ ...prev, [item.eventId]: value }))}
          />
        ))}
      </ol>

      {error && <Notice tone="danger" title={error} />}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => submit([])} disabled={submitting} className="btn-secondary">
          <Check className="h-4 w-4" aria-hidden="true" />
          Tout garder
        </button>
        <button type="button" onClick={() => submit(decisions)} disabled={submitting} className="btn-primary">
          <UserCheck className="h-4 w-4" aria-hidden="true" />
          {decisions.length ? `Appliquer ${decisions.length} correction${decisions.length > 1 ? "s" : ""} et rédiger` : "Valider et rédiger"}
        </button>
      </div>
    </section>
  );
}
