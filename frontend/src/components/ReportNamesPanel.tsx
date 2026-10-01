import { useState } from "react";
import { fetchReportNames, saveReportNames, type ReportNames } from "../lib/api";
import NameDictionaryEditor from "./NameDictionaryEditor";
import Notice from "./ui/Notice";

export default function ReportNamesPanel({ reportId, onSaved }: { reportId: string; onSaved?: (markdown: string) => void | Promise<void> }) {
  const [data, setData] = useState<ReportNames | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (open) { setOpen(false); return; }
    setBusy(true); setError(null);
    try { setData(await fetchReportNames(reportId)); setOpen(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!data) return;
    setBusy(true); setError(null);
    try {
      const result = await saveReportNames(reportId, data.nameDictionary);
      await onSaved?.(result.reportMd);
      setOpen(false);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="mb-6 space-y-4">
      <button type="button" className="btn-secondary btn-sm" onClick={load} disabled={busy} aria-expanded={open}>
        {busy ? "Chargement…" : open ? "Fermer le dictionnaire" : "Noms et personnages"}
      </button>
      {error && <Notice tone="danger" title={error} />}
      {open && data && (
        <div className="card space-y-5 p-5">
          {!!data.warnings?.length && <Notice tone="warn" title="Le contrôle global signale des noms à revoir">
            <ul className="list-disc pl-5">{data.warnings.map((w) => <li key={`${w.name}-${w.reason}`}>{w.name} : {w.reason}</li>)}</ul>
          </Notice>}
          <NameDictionaryEditor names={data.nameDictionary} evidence={data.evidence} onChange={(nameDictionary) => setData({ ...data, nameDictionary })} disabled={busy} />
          <p className="text-sm text-ink-muted">Les renommages et variantes confirmées s'appliquent à tout le compte rendu. Après une séparation ou une nouvelle attribution, régénère les scènes concernées pour actualiser le récit.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Annuler</button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy}>{busy ? "Enregistrement…" : "Appliquer au compte rendu"}</button>
          </div>
        </div>
      )}
    </section>
  );
}
