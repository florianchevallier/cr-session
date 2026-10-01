import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { jobAudioUrl, type NameEntry, type NameEvidence } from "../lib/api";

export default function NameDictionaryEditor({ names, evidence = [], onChange, jobId, hasAudio = false, disabled = false }: {
  names: NameEntry[]; evidence?: NameEvidence[]; onChange: (names: NameEntry[]) => void;
  jobId?: string; hasAudio?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const update = (entry: NameEntry) => onChange(names.map((n) => n.id === entry.id ? entry : n));
  const newId = () => crypto.randomUUID();
  const separate = (entry: NameEntry, index: number) => {
    const alias = entry.aliases[index];
    onChange([...names.map((n) => n.id === entry.id ? { ...n, aliases: n.aliases.map((a, i) => i === index ? { ...a, status: "rejected" as const } : a) } : n),
      ...(names.some((n) => n.canonical.toLocaleLowerCase() === alias.name.toLocaleLowerCase()) ? [] : [{ id: newId(), canonical: alias.name, kind: entry.kind, status: "confirmed" as const, aliases: [] }])]);
  };
  const merge = (source: NameEntry, targetId: string) => {
    const target = names.find((n) => n.id === targetId);
    if (!target) return;
    onChange(names.filter((n) => n.id !== source.id).map((n) => n.id === targetId ? {
      ...n, status: "confirmed", assignedEventIds: [...(n.assignedEventIds ?? []), ...(source.assignedEventIds ?? [])],
      aliases: [...n.aliases, ...source.aliases, { name: source.canonical, kind: "alias", status: "confirmed", reason: "Fusion explicite par l'utilisateur", eventIds: [] }],
    } : n));
  };
  const assign = (eventId: string, targetId: string) => onChange(names.map((n) => ({ ...n,
    assignedEventIds: [...(n.assignedEventIds ?? []).filter((e) => e !== eventId), ...(n.id === targetId ? [eventId] : [])] })));

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="text-lg font-semibold text-ink">Noms et personnages</legend>
      <p className="text-sm text-ink-muted">Vérifie les noms proposés. Seules les variantes confirmées seront remplacées. Deux personnages restent distincts tant que tu ne les fusionnes pas explicitement.</p>
      <div className="divide-y divide-line">
        {names.map((entry) => {
          const related = evidence.filter((e) => [entry.canonical, ...entry.aliases.map((a) => a.name)].some((name) => name && e.text.toLocaleLowerCase().includes(name.toLocaleLowerCase())) || entry.aliases.some((a) => a.eventIds.includes(e.eventId)));
          return (
            <div key={entry.id} className="space-y-3 py-5 first:pt-0">
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div>
                  <label htmlFor={`${id}-${entry.id}-name`} className="label">Nom retenu · {entry.kind}</label>
                  <input id={`${id}-${entry.id}-name`} className="input" value={entry.canonical} maxLength={120}
                    onChange={(e) => update({ ...entry, canonical: e.target.value })} />
                </div>
                <select aria-label={`Type de ${entry.canonical}`} className="input" value={entry.kind} onChange={(e) => update({ ...entry, kind: e.target.value as NameEntry["kind"] })}>
                  <option value="PJ">PJ</option><option value="PNJ">PNJ</option>
                </select>
                <button type="button" className="btn-secondary btn-sm" onClick={() => update({ ...entry, status: "confirmed" })}>
                  {entry.status === "confirmed" ? "Nom confirmé" : "Confirmer le nom"}
                </button>
              </div>
              {entry.aliases.map((alias, i) => (
                <div key={`${entry.id}-alias-${i}`} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="input w-auto" aria-label={`Nom de la variante ${i + 1} de ${entry.canonical}`} value={alias.name} maxLength={120}
                      onChange={(e) => update({ ...entry, aliases: entry.aliases.map((a, j) => j === i ? { ...a, name: e.target.value } : a) })} />
                    <span className="text-xs text-ink-muted">{alias.kind === "transcription" ? "Transcription" : "Alias"}</span>
                    <select aria-label={`Décision pour ${alias.name}, variante de ${entry.canonical}`} className="input w-auto text-sm" value={alias.status}
                      onChange={(e) => update({ ...entry, aliases: entry.aliases.map((a, j) => j === i ? { ...a, status: e.target.value as typeof a.status } : a) })}>
                      <option value="proposed">À confirmer · inactif</option><option value="confirmed">Variante confirmée</option><option value="rejected">Rapprochement refusé</option>
                    </select>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => separate(entry, i)}>C'est un autre personnage</button>
                  </div>
                  {alias.reason && <p className="text-sm text-ink-muted">{alias.reason}</p>}
                </div>
              ))}
              <button type="button" className="btn-ghost btn-sm" onClick={() => update({ ...entry, aliases: [...entry.aliases, { name: "Nouvelle variante", kind: "alias", status: "proposed", reason: "Ajout humain", eventIds: [] }] })}>Ajouter une variante</button>
              {related.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-ink">Voir les {related.length} passages sources</summary>
                  <div className="mt-3 space-y-4">
                    {related.map((source) => (
                      <div key={source.eventId} className="space-y-2">
                        <p className="whitespace-pre-line text-sm text-ink-muted">{source.text}</p>
                        {jobId && hasAudio && <audio controls preload="none" className="w-full" src={jobAudioUrl(jobId, source.start, source.end)} aria-label={`Source de ${entry.canonical}`} />}
                        <select className="input" aria-label={`Acteur de l'occurrence ${source.eventId}`}
                          value={names.find((n) => n.assignedEventIds?.includes(source.eventId))?.id ?? ""} onChange={(e) => assign(source.eventId, e.target.value)}>
                          <option value="">Conserver l'attribution du registre</option>
                          {names.map((n) => <option key={n.id} value={n.id}>{n.canonical}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <details>
                <summary className="cursor-pointer text-sm text-ink-muted">Fusionner avec un personnage existant</summary>
                <p className="mt-2 text-sm text-ink-muted">À utiliser uniquement si ces deux entrées désignent bien le même personnage.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select className="input w-auto" aria-label={`Fusionner ${entry.canonical} avec`} value={mergeTargets[entry.id] ?? ""} onChange={(e) => setMergeTargets((prev) => ({ ...prev, [entry.id]: e.target.value }))}>
                    <option value="">Choisir le personnage à conserver</option>
                    {names.filter((n) => n.id !== entry.id).map((n) => <option key={n.id} value={n.id}>{n.canonical}</option>)}
                  </select>
                  <button type="button" className="btn-secondary btn-sm" disabled={!mergeTargets[entry.id]} onClick={() => merge(entry, mergeTargets[entry.id])}>Confirmer la fusion</button>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn-secondary btn-sm" onClick={() => onChange([...names, { id: newId(), canonical: "Nouveau personnage", kind: "PNJ", status: "proposed", aliases: [] }])}>
        <Plus className="h-4 w-4" aria-hidden="true" />Ajouter un personnage
      </button>
    </fieldset>
  );
}
