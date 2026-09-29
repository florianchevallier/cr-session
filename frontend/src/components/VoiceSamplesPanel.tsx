import { useCallback, useEffect, useId, useState } from "react";
import { Check, Mic, Trash2, Upload, X } from "lucide-react";
import {
  deleteVoiceprint,
  listVoiceprints,
  updateVoiceprint,
  uploadVoiceprint,
  voiceprintAudioUrl,
  type PlayerInfo,
  type Voiceprint,
} from "../lib/api";

interface VoiceSamplesPanelProps {
  universeId: string;
  players: PlayerInfo[];
}

/** Personnes réelles à la table (MJ + joueurs), sans doublon. */
function peopleOf(players: PlayerInfo[]): string[] {
  return [
    ...new Set(
      players
        .filter((p) => (p.role ?? "player") !== "npc")
        .map((p) => p.playerName.trim())
        .filter(Boolean)
    ),
  ];
}

function PersonRow({
  person,
  people,
  samples,
  universeId,
  onChange,
}: {
  person: string;
  people: string[];
  samples: Voiceprint[];
  universeId: string;
  onChange: () => void;
}) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadVoiceprint(universeId, person, file);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, change: { status?: "confirmed"; personName?: string }) => {
    setError(null);
    try {
      await updateVoiceprint(id, change);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteVoiceprint(id);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <li className="rounded-lg border border-line bg-sunken/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">{person}</p>
        <label htmlFor={inputId} className={`btn-secondary btn-sm cursor-pointer ${busy ? "opacity-60" : ""}`}>
          <Upload className="h-4 w-4" aria-hidden="true" />
          {busy ? "Envoi…" : samples.some((s) => s.status === "confirmed") ? "Ajouter un autre" : "Ajouter un échantillon"}
          <input
            id={inputId}
            type="file"
            accept="audio/*,.aac,.m4a,.mp3,.wav,.ogg,.opus,.flac,.webm"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {samples.length === 0 ? (
        <p className="hint mt-1 text-xs">Aucun échantillon : l'analyse se fie au contexte et à la diarisation.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {samples.map((s) =>
            s.status === "pending" ? (
              <li key={s.id} className="space-y-2 rounded-md border border-warn/30 bg-warn-soft p-2">
                <p className="text-xs text-ink">
                  <span className="font-semibold">Proposé automatiquement, à vérifier.</span>{" "}
                  <span className="text-ink-muted">{s.source}</span>
                </p>
                <audio controls preload="none" src={voiceprintAudioUrl(s.id)} className="h-8 w-full" />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => patch(s.id, { status: "confirmed" })} className="btn-secondary btn-sm">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    C'est bien {person}
                  </button>
                  <button type="button" onClick={() => remove(s.id)} className="btn-ghost btn-sm">
                    <X className="h-4 w-4" aria-hidden="true" />
                    Ce n'est pas {person}
                  </button>
                  {people.length > 1 && (
                    <select
                      aria-label={`Attribuer cet échantillon à quelqu'un d'autre que ${person}`}
                      value=""
                      onChange={(e) => e.target.value && patch(s.id, { personName: e.target.value, status: "confirmed" })}
                      className="input w-auto py-1 text-sm"
                    >
                      <option value="">C'est la voix de…</option>
                      {people
                        .filter((p) => p !== person)
                        .map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </li>
            ) : (
              <li key={s.id} className="flex items-center gap-2">
                <audio controls preload="none" src={voiceprintAudioUrl(s.id)} className="h-8 min-w-0 flex-1" />
                <span className="hidden text-xs text-ink-muted sm:inline">
                  {s.durationSec ? `${Math.round(s.durationSec)} s` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => remove(s.id)}
                  className="icon-btn-danger"
                  aria-label={`Supprimer l'échantillon de ${person}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            )
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export default function VoiceSamplesPanel({ universeId, players }: VoiceSamplesPanelProps) {
  const [samples, setSamples] = useState<Voiceprint[]>([]);
  const people = peopleOf(players);

  const refresh = useCallback(async () => {
    try {
      setSamples(await listVoiceprints(universeId));
    } catch {
      setSamples([]);
    }
  }, [universeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (people.length === 0) {
    return <p className="hint">Renseigne d'abord le MJ et les joueurs.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="hint flex items-start gap-2">
        <Mic className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        10 à 30 secondes où la personne parle seule. L'échantillon validé le plus récent est comparé à la séance pour
        reconnaître sa voix (enregistrements audio uniquement). Après chaque séance audio, des extraits sont proposés
        automatiquement : écoute-les et valide ceux qui sont justes.
      </p>
      <ul className="space-y-2">
        {people.map((person) => (
          <PersonRow
            key={person}
            person={person}
            people={people}
            universeId={universeId}
            samples={samples.filter((s) => s.personName.toLowerCase() === person.toLowerCase())}
            onChange={refresh}
          />
        ))}
      </ul>
    </div>
  );
}
