import { Users, Plus, Trash2 } from "lucide-react";
import type { PlayerInfo } from "../lib/api";

interface PlayerFormProps {
  players: PlayerInfo[];
  onChange: (players: PlayerInfo[]) => void;
}

export default function PlayerForm({ players, onChange }: PlayerFormProps) {
  const addPlayer = () => {
    onChange([
      ...players,
      { playerName: "", characterName: "", speakerHint: "" },
    ]);
  };

  const removePlayer = (index: number) => {
    onChange(players.filter((_, i) => i !== index));
  };

  const updatePlayer = (index: number, field: keyof PlayerInfo, value: string) => {
    const updated = players.map((p, i) =>
      i === index ? { ...p, [field]: value } : p
    );
    onChange(updated);
  };

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-parchment-600" />
          <h3 className="text-sm font-semibold text-parchment-900">
            Joueurs
          </h3>
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
          <div
            key={index}
            className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end"
          >
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
              {index === 0 && <label className="label">Personnage (PJ)</label>}
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
              onClick={() => removePlayer(index)}
              className="rounded-lg p-2.5 text-parchment-400 transition-colors hover:bg-red-50 hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
