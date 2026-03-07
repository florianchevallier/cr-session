import { useState } from "react";
import { Users, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { PlayerInfo } from "../lib/api";

interface PlayerFormProps {
  players: PlayerInfo[];
  onChange: (players: PlayerInfo[]) => void;
}

export default function PlayerForm({ players, onChange }: PlayerFormProps) {
  const [expandedDetails, setExpandedDetails] = useState<Set<number>>(
    new Set()
  );

  const addPlayer = () => {
    onChange([
      ...players,
      { playerName: "", characterName: "", speakerHint: "" },
    ]);
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

  const updatePlayer = (
    index: number,
    field: keyof PlayerInfo,
    value: string
  ) => {
    const updated = players.map((p, i) =>
      i === index ? { ...p, [field]: value } : p
    );
    onChange(updated);
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
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-parchment-600" />
          <h3 className="text-sm font-semibold text-parchment-900">Joueurs</h3>
        </div>
        <button onClick={addPlayer} className="btn-secondary text-xs">
          <Plus className="h-3.5 w-3.5" />
          Ajouter
        </button>
      </div>

      {players.length === 0 && (
        <p className="text-xs text-parchment-400 italic">
          Ajoute les joueurs pour aider l'analyse du transcript.
        </p>
      )}

      <div className="space-y-3">
        {players.map((player, index) => (
          <div key={index} className="space-y-1">
            <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-2 items-end">
              <div>
                {index === 0 && <label className="label">Joueur</label>}
                <input
                  type="text"
                  value={player.playerName}
                  onChange={(e) =>
                    updatePlayer(index, "playerName", e.target.value)
                  }
                  placeholder="Emilie"
                  className="input"
                />
              </div>
              <div>
                {index === 0 && (
                  <label className="label">Personnage (PJ)</label>
                )}
                <input
                  type="text"
                  value={player.characterName}
                  onChange={(e) =>
                    updatePlayer(index, "characterName", e.target.value)
                  }
                  placeholder="Yumi"
                  className="input"
                />
              </div>
              <div>
                {index === 0 && (
                  <label className="label text-xs">Speaker ID</label>
                )}
                <input
                  type="text"
                  value={player.speakerHint || ""}
                  onChange={(e) =>
                    updatePlayer(index, "speakerHint", e.target.value)
                  }
                  placeholder="SPEAKER_00"
                  className="input w-32 text-xs"
                />
              </div>
              <button
                onClick={() => toggleDetails(index)}
                className="rounded-lg p-2.5 text-parchment-400 transition-colors hover:bg-parchment-100 hover:text-parchment-600"
                title="Détails du personnage"
              >
                {expandedDetails.has(index) ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              <button
                onClick={() => removePlayer(index)}
                className="rounded-lg p-2.5 text-parchment-400 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {expandedDetails.has(index) && (
              <div className="ml-0 pl-2 border-l-2 border-parchment-200">
                <label className="label text-xs text-parchment-500">
                  Détails du personnage{" "}
                  <span className="font-normal">
                    (compétences, sphères, classe, limitations...)
                  </span>
                </label>
                <textarea
                  value={player.characterDetails || ""}
                  onChange={(e) =>
                    updatePlayer(index, "characterDetails", e.target.value)
                  }
                  placeholder="Ex: Sphères Esprit 3, Forces 2. Ne maîtrise pas l'Entropie. Rôle : éclaireur spirituel."
                  className="input min-h-[60px] text-xs resize-y"
                  rows={2}
                />
              </div>
            )}

            {!expandedDetails.has(index) && player.characterDetails && (
              <button
                onClick={() => toggleDetails(index)}
                className="text-[10px] text-parchment-400 italic hover:text-parchment-600 transition-colors pl-1"
              >
                {player.characterDetails.length > 60
                  ? player.characterDetails.slice(0, 60) + "..."
                  : player.characterDetails}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
