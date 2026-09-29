import { useId, useState } from "react";
import { Plus, Trash2, ChevronDown } from "lucide-react";
import type { CastRole, PlayerInfo } from "../lib/api";

interface PlayerFormProps {
  players: PlayerInfo[];
  onChange: (players: PlayerInfo[]) => void;
}

function playerLabel(player: PlayerInfo, index: number): string {
  return player.characterName.trim() || player.playerName.trim() || `ligne ${index + 1}`;
}

const ROLE_LABELS: Record<CastRole, string> = { player: "Joueur", gm: "MJ", npc: "PNJ" };

const PLACEHOLDERS: Record<CastRole, { player: string; character: string; details: string }> = {
  player: {
    player: "Prénom",
    character: "Nom du PJ",
    details: "Ex. : Sphères Esprit 3, Forces 2. Rôle : éclaireur spirituel. Porte un chat-esprit.",
  },
  gm: {
    player: "Prénom du MJ",
    character: "—",
    details: "Ex. : fait parler les PNJ avec des voix marquées.",
  },
  npc: {
    player: "—",
    character: "Nom du PNJ",
    details: "Ex. : dirigeant technocrate de WebProof, allié ambigu.",
  },
};

export default function PlayerForm({ players, onChange }: PlayerFormProps) {
  const baseId = useId();
  const [expandedDetails, setExpandedDetails] = useState<Set<number>>(new Set());

  const addPlayer = () => {
    onChange([...players, { playerName: "", characterName: "", role: "player" }]);
  };

  const removePlayer = (index: number) => {
    onChange(players.filter((_, i) => i !== index));
    setExpandedDetails((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  };

  const updatePlayer = (index: number, field: keyof PlayerInfo, value: string) => {
    if (field === "role") {
      // Un seul MJ : choisir « MJ » sur une ligne rend les autres lignes MJ joueurs.
      onChange(
        players.map((p, i) =>
          i === index ? { ...p, role: value as CastRole } : value === "gm" && p.role === "gm" ? { ...p, role: "player" } : p
        )
      );
      return;
    }
    onChange(players.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  };

  const toggleDetails = (index: number) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {players.length === 0 ? (
        <p className="hint">
          Personne pour l'instant. Ajoute le MJ, chaque joueur avec son personnage, et les PNJ récurrents :
          l'analyse s'en sert pour savoir qui fait quoi.
        </p>
      ) : (
        <>
          {/* Column headers, desktop only: each field also carries its own label. */}
          <div
            className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8.5rem_5.5rem] gap-3 px-1 sm:grid"
            aria-hidden="true"
          >
            <span className="text-sm font-medium text-ink">Joueur</span>
            <span className="text-sm font-medium text-ink">Personnage</span>
            <span className="text-sm font-medium text-ink">Rôle</span>
            <span />
          </div>

          <ol className="space-y-3">
            {players.map((player, index) => {
              const id = `${baseId}-${index}`;
              const name = playerLabel(player, index);
              const isOpen = expandedDetails.has(index);
              const role = player.role ?? "player";
              const placeholder = PLACEHOLDERS[role];
              return (
                <li
                  key={index}
                  className="rounded-lg border border-line bg-sunken/60 p-3 sm:border-0 sm:bg-transparent sm:p-0"
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8.5rem_5.5rem] sm:items-center">
                    <div>
                      <label htmlFor={`${id}-player`} className="label sm:sr-only">
                        Joueur<span className="sr-only"> {index + 1}</span>
                      </label>
                      <input
                        id={`${id}-player`}
                        type="text"
                        value={player.playerName}
                        onChange={(e) => updatePlayer(index, "playerName", e.target.value)}
                        placeholder={placeholder.player}
                        disabled={role === "npc"}
                        autoComplete="off"
                        className="input"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${id}-character`} className="label sm:sr-only">
                        Personnage<span className="sr-only"> du joueur {index + 1}</span>
                      </label>
                      <input
                        id={`${id}-character`}
                        type="text"
                        value={player.characterName}
                        onChange={(e) => updatePlayer(index, "characterName", e.target.value)}
                        placeholder={role === "gm" ? "PJ joué par le MJ (facultatif)" : placeholder.character}
                        autoComplete="off"
                        className="input"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${id}-role`} className="label sm:sr-only">
                        Rôle<span className="sr-only"> de la ligne {index + 1}</span>
                      </label>
                      <select
                        id={`${id}-role`}
                        value={role}
                        onChange={(e) => updatePlayer(index, "role", e.target.value)}
                        className="input"
                      >
                        {(Object.keys(ROLE_LABELS) as CastRole[]).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-end justify-end gap-1 sm:items-center">
                      <button
                        type="button"
                        onClick={() => toggleDetails(index)}
                        className="icon-btn"
                        aria-expanded={isOpen}
                        aria-controls={`${id}-details`}
                        aria-label={`Détails de ${name}`}
                        title="Détails du personnage"
                      >
                        <ChevronDown
                          className={`h-5 w-5 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => removePlayer(index)}
                        className="icon-btn-danger"
                        aria-label={`Retirer ${name}`}
                        title="Retirer ce joueur"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {isOpen ? (
                    <div id={`${id}-details`} className="mt-3 space-y-3 border-l-2 border-line-strong pl-3">
                      {role !== "gm" && (
                        <div>
                          <label htmlFor={`${id}-aliases`} className="label">
                            Autres noms{" "}
                            <span className="font-normal text-ink-muted">(alias, surnoms, séparés par des virgules)</span>
                          </label>
                          <input
                            id={`${id}-aliases`}
                            type="text"
                            value={player.aliases || ""}
                            onChange={(e) => updatePlayer(index, "aliases", e.target.value)}
                            placeholder="Ex. : Mei, Professeur Stan"
                            autoComplete="off"
                            className="input"
                          />
                        </div>
                      )}
                      <div>
                      <label htmlFor={`${id}-details-input`} className="label">
                        Détails de {name}{" "}
                        <span className="font-normal text-ink-muted">
                          (compétences, sphères, classe, limites…)
                        </span>
                      </label>
                      <textarea
                        id={`${id}-details-input`}
                        value={player.characterDetails || ""}
                        onChange={(e) => updatePlayer(index, "characterDetails", e.target.value)}
                        placeholder={placeholder.details}
                        className="textarea min-h-[4.5rem]"
                        rows={2}
                      />
                      </div>
                    </div>
                  ) : (
                    player.characterDetails && (
                      <button
                        type="button"
                        onClick={() => toggleDetails(index)}
                        className="mt-2 block max-w-full truncate text-left text-sm italic text-ink-muted hover:text-ink"
                      >
                        {player.characterDetails}
                      </button>
                    )
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" onClick={addPlayer} className="btn-secondary btn-sm self-start">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Ajouter une ligne
        </button>
        <p className="hint text-xs sm:text-right">
          Une ligne « MJ », une par joueur, une par PNJ récurrent. Si le MJ joue un PJ, ajoute une ligne « Joueur » à son nom.
        </p>
      </div>
    </div>
  );
}
