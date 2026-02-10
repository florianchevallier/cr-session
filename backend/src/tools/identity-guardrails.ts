import { WorkflowStateType } from "../graph/state.js";

export type CharacterIdentity = {
  canonical: string;
  aliases: string[];
};

type Match = {
  mergedName: string;
  leftCanonical: string;
  rightCanonical: string;
};

const SPACE_RE = /\s+/g;
const ALIAS_SPLIT_RE = /[\/|,;]+/;

function compactWhitespace(value: string): string {
  return value.trim().replace(SPACE_RE, " ");
}

function normalizeForCompare(value: string): string {
  return compactWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(SPACE_RE, " ")
    .trim();
}

function extractAliases(raw: string): string[] {
  const cleaned = compactWhitespace(raw);
  if (!cleaned) return [];

  const aliases = new Set<string>();
  aliases.add(cleaned);

  for (const part of cleaned.split(ALIAS_SPLIT_RE)) {
    const alias = compactWhitespace(part);
    if (alias) aliases.add(alias);
  }

  const parentheticalGroups = [...cleaned.matchAll(/\(([^)]+)\)/g)].map(
    (m) => m[1]
  );
  for (const group of parentheticalGroups) {
    for (const part of group.split(ALIAS_SPLIT_RE)) {
      const alias = compactWhitespace(part);
      if (alias) aliases.add(alias);
    }
  }

  return [...aliases];
}

function isUsefulAlias(alias: string): boolean {
  const normalized = normalizeForCompare(alias);
  if (!normalized) return false;
  if (normalized === "mj" || normalized === "maitre du jeu") return false;
  return normalized.length >= 2;
}

function collectIdentityCandidates(state: WorkflowStateType): string[] {
  const candidates: string[] = [];

  for (const player of state.playerInfo ?? []) {
    if (player.characterName?.trim()) candidates.push(player.characterName.trim());
  }

  for (const pc of state.entities?.pcs ?? []) {
    if (pc.name?.trim()) candidates.push(pc.name.trim());
  }

  for (const speakerIdentity of Object.values(state.speakerMap ?? {})) {
    if (!speakerIdentity?.trim()) continue;
    const parentheticalGroups = [
      ...speakerIdentity.matchAll(/\(([^)]+)\)/g),
    ].map((m) => m[1]);
    if (parentheticalGroups.length > 0) {
      candidates.push(...parentheticalGroups.map((s) => s.trim()));
    }
  }

  return candidates;
}

export function buildCharacterIdentities(
  state: WorkflowStateType
): CharacterIdentity[] {
  const buckets = new Map<
    string,
    {
      canonical: string;
      aliases: Set<string>;
    }
  >();

  for (const candidate of collectIdentityCandidates(state)) {
    const aliases = extractAliases(candidate).filter(isUsefulAlias);
    if (aliases.length === 0) continue;

    const canonical = aliases[0];
    const canonicalKey = normalizeForCompare(canonical);
    if (!canonicalKey) continue;

    const bucket = buckets.get(canonicalKey) ?? {
      canonical,
      aliases: new Set<string>(),
    };

    for (const alias of aliases) bucket.aliases.add(alias);
    buckets.set(canonicalKey, bucket);
  }

  return [...buckets.values()]
    .map((b) => ({
      canonical: b.canonical,
      aliases: [...b.aliases].sort((a, b) => a.length - b.length),
    }))
    .sort((a, b) =>
      a.canonical.localeCompare(b.canonical, "fr", { sensitivity: "base" })
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasToRegex(alias: string): string {
  return compactWhitespace(alias)
    .split(" ")
    .filter(Boolean)
    .map((token) => escapeRegExp(token))
    .join("\\s+");
}

function buildTokenCollisions(identities: CharacterIdentity[]): string[] {
  const tokenOwners = new Map<string, Set<string>>();

  for (const identity of identities) {
    for (const alias of identity.aliases) {
      const tokens = normalizeForCompare(alias).split(" ").filter(Boolean);
      for (const token of tokens) {
        if (token.length < 4) continue;
        const owners = tokenOwners.get(token) ?? new Set<string>();
        owners.add(identity.canonical);
        tokenOwners.set(token, owners);
      }
    }
  }

  return [...tokenOwners.entries()]
    .filter(([, owners]) => owners.size > 1)
    .sort((a, b) => a[0].localeCompare(b[0], "fr", { sensitivity: "base" }))
    .slice(0, 8)
    .map(
      ([token, owners]) =>
        `- Token "${token}" partage entre ${[...owners].join(" / ")} -> ne jamais fusionner les identites`
    );
}

export function buildIdentityGuardrailsText(
  identities: CharacterIdentity[]
): string {
  if (identities.length === 0) {
    return (
      "### Garde-fous d'attribution\n" +
      "- Aucun roster fiable detecte. Reste tres prudent sur l'attribution des actions."
    );
  }

  const rosterLines = identities.map((identity) => {
    const aliasList = identity.aliases.filter((a) => a !== identity.canonical);
    return aliasList.length > 0
      ? `- ${identity.canonical} (alias: ${aliasList.join(", ")})`
      : `- ${identity.canonical}`;
  });

  const collisionLines = buildTokenCollisions(identities);
  const collisionSection =
    collisionLines.length > 0
      ? `\n- Noms potentiellement ambigus (tokens partages) :\n${collisionLines.join("\n")}`
      : "";

  return (
    "### Garde-fous d'attribution\n" +
    "- Personnages distincts a ne jamais fusionner :\n" +
    `${rosterLines.join("\n")}` +
    `${collisionSection}\n` +
    "- Interdiction absolue : ne jamais creer de nom hybride (ex: combinaison de 2 personnages).\n" +
    "- Si l'agent d'une action est ambigu, explicite l'incertitude au lieu d'inventer."
  );
}

export function findPotentiallyMergedNames(
  text: string,
  identities: CharacterIdentity[]
): Match[] {
  if (!text.trim() || identities.length < 2) return [];

  const findings: Match[] = [];
  const dedupe = new Set<string>();

  for (let i = 0; i < identities.length; i++) {
    for (let j = i + 1; j < identities.length; j++) {
      const left = identities[i];
      const right = identities[j];

      const leftAliases = left.aliases.filter((a) => normalizeForCompare(a).length >= 3);
      const rightAliases = right.aliases.filter((a) => normalizeForCompare(a).length >= 3);

      for (const la of leftAliases) {
        for (const ra of rightAliases) {
          const leftRegex = aliasToRegex(la);
          const rightRegex = aliasToRegex(ra);
          if (!leftRegex || !rightRegex) continue;

          const patterns = [
            new RegExp(`\\b${leftRegex}\\s+${rightRegex}\\b`, "i"),
            new RegExp(`\\b${rightRegex}\\s+${leftRegex}\\b`, "i"),
          ];

          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match?.[0]) continue;
            const mergedName = compactWhitespace(match[0]);
            const key = `${normalizeForCompare(mergedName)}::${normalizeForCompare(
              left.canonical
            )}::${normalizeForCompare(right.canonical)}`;
            if (dedupe.has(key)) continue;
            dedupe.add(key);
            findings.push({
              mergedName,
              leftCanonical: left.canonical,
              rightCanonical: right.canonical,
            });
          }
        }
      }
    }
  }

  return findings;
}
