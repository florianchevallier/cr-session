export interface Universe {
  id: string;
  label: string;
  defaultPrompt: string;
}

export interface PlayerInfo {
  playerName: string;
  characterName: string;
  speakerHint?: string;
}

export interface ProcessConfig {
  transcript: File;
  universeName: string;
  universeContext: string;
  sessionHistory: string;
  playerInfo: PlayerInfo[];
}

interface CreateUniverseInput {
  label: string;
  defaultPrompt: string;
}

export async function fetchUniverses(): Promise<Universe[]> {
  const res = await fetch("/api/universes");
  if (!res.ok) throw new Error("Failed to fetch universes");
  return res.json();
}

export async function createUniverse(
  input: CreateUniverseInput
): Promise<Universe> {
  const res = await fetch("/api/universes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    let errorMessage = "Failed to create universe";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) {
        errorMessage = body.message;
      }
    } catch {
      // Ignore JSON parse errors and keep default message.
    }
    throw new Error(errorMessage);
  }

  return res.json();
}

export interface UniverseDraft {
  universeContext: string;
  sessionHistory: string;
  defaultPlayers?: PlayerInfo[];
}

export async function fetchUniverseDraft(
  universeId: string
): Promise<UniverseDraft | null> {
  const res = await fetch(`/api/universes/${encodeURIComponent(universeId)}/draft`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch draft");
  return res.json();
}

export async function saveUniverseDraft(
  universeId: string,
  draft: UniverseDraft
): Promise<void> {
  const res = await fetch(
    `/api/universes/${encodeURIComponent(universeId)}/draft`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }
  );
  if (!res.ok) throw new Error("Failed to save draft");
}

export async function checkHealth(): Promise<{ status: string; hasApiKey: boolean }> {
  const res = await fetch("/api/health");
  return res.json();
}
