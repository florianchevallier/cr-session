import { z } from "zod";
import { WorkflowStateType, CharacterProfileSchema } from "../graph/state.js";

export type CharacterIdentity = {
  canonical: string;
  aliases: string[];
};

type CharacterProfile = z.infer<typeof CharacterProfileSchema>;

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
  identities: CharacterIdentity[],
  profiles?: CharacterProfile[]
): string {
  if (identities.length === 0 && (!profiles || profiles.length === 0)) {
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

  let text =
    "### Garde-fous d'attribution\n" +
    "- Personnages distincts a ne jamais fusionner :\n" +
    `${rosterLines.join("\n")}` +
    `${collisionSection}\n` +
    "- Interdiction absolue : ne jamais creer de nom hybride (ex: combinaison de 2 personnages).\n" +
    "- Si l'agent d'une action est ambigu, explicite l'incertitude au lieu d'inventer.";

  if (profiles && profiles.length > 0) {
    text += buildAbilityGuardrailsText(profiles);
  }

  return text;
}

export function buildAbilityGuardrailsText(
  profiles: CharacterProfile[]
): string {
  if (profiles.length === 0) return "";

  const lines: string[] = [
    "",
    "",
    "### Compétences par personnage (RÉFÉRENCE OBLIGATOIRE POUR VÉRIFIER LES ATTRIBUTIONS)",
    "",
  ];

  for (const p of profiles) {
    lines.push(`**${p.characterName}** (joué par ${p.playerName}) :`);
    if (p.knownAbilities.length > 0) {
      lines.push(`  ✅ Maîtrise : ${p.knownAbilities.join(", ")}`);
    }
    if (p.prohibitedAbilities.length > 0) {
      lines.push(`  ❌ NE maîtrise PAS : ${p.prohibitedAbilities.join(", ")}`);
    }
    lines.push(`  Rôle : ${p.roleInGroup}`);
    if (p.speechPatterns.length > 0) {
      lines.push(`  Patterns de parole : ${p.speechPatterns.join(" | ")}`);
    }
    lines.push("");
  }

  lines.push(
    "⚠️ Si une action utilise une compétence ❌ pour un personnage, c'est probablement une ERREUR de diarization.",
    "   → Chercher dans le contexte quel personnage possède réellement cette compétence.",
    ""
  );

  return lines.join("\n");
}

const GAME_MECHANIC_TERMS = [
  "sphère",
  "sphere",
  "sort",
  "magie",
  "magyque",
  "magique",
  "incantation",
  "quintessence",
  "arete",
  "arété",
  "paradoxe",
  "vulgarit",
  "dégâts",
  "dommages",
  "contusion",
  "blessure",
  "points de vie",
  "pv",
  "pdv",
  "soins",
  "guérison",
  "inventaire",
  "focus",
  "Forces",
  "Esprit",
  "Vie",
  "Entropie",
  "Correspondance",
  "Temps",
  "Prime",
  "Matière",
  "Mental",
  "canalise",
  "invoque",
  "conjure",
  "incante",
  "vortex",
];

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|(?:\n)+/).filter((s) => s.trim().length > 5);
}

function collectGMNames(speakerMap: Record<string, string>): Set<string> {
  const gmNames = new Set<string>();
  for (const identity of Object.values(speakerMap)) {
    const normalized = identity.trim().toLowerCase();
    if (
      normalized.includes("(mj)") ||
      normalized === "mj" ||
      normalized.includes("maître du jeu") ||
      normalized.includes("maitre du jeu") ||
      normalized.includes("game master") ||
      normalized.includes("(gm)")
    ) {
      const name = identity.replace(/\s*\(.*?\)\s*/g, "").trim();
      if (name) gmNames.add(name);
      gmNames.add("MJ");
      gmNames.add("le MJ");
    }
  }
  return gmNames;
}

const GM_NARRATIVE_VERBS =
  /\b(?:décri[ts]?|expliqu|annonc|di[ts]|raconter?|demand|propos|présent|montr|indiqu|rappel|prévi[en]|averti|confirm|précis|introdui|narre|révèl|signal|intervien)/i;

export function findGMAsCharacterIssues(
  text: string,
  speakerMap: Record<string, string>
): string[] {
  const gmNames = collectGMNames(speakerMap);
  if (gmNames.size === 0) return [];

  const issues: string[] = [];
  const sentences = splitSentences(text);

  const gmActionVerbs =
    /\b(?:effectu|utilis|lanc[eé]|canalis|activ|invoqu|conjur|jett?e|déploie?|déclench|jet(?:te)?|soign|guéri|combat|attaqu|par[eé]|esquiv|encaiss|reçoi[ts]|subit?|prend|récupèr|regagn|absorb|manifest|analyse|incante|frappe|bloqu|esquiv)\w*/i;

  const gmAsObject =
    /\b(?:soigner|guérir|blesser|frapper|attaquer|toucher|heal|protéger|sauver|aider)\s+(?:totalement\s+|complètement\s+|entièrement\s+)?(?:le\s+|l')?/i;

  const gmPassivePatterns = [
    /est\s+(?:blessé|soigné|guéri|touché|frappé|protégé|sauvé|attaqué)/i,
    /(?:sa|ses|son)\s+(?:dernière|blessure|contusion|point|santé|vie|vigueur)/i,
  ];

  const mechanicTermsRe = new RegExp(
    `\\b(?:${GAME_MECHANIC_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "i"
  );

  for (const sentence of sentences) {
    const sentenceLower = sentence.toLowerCase();

    for (const gmName of gmNames) {
      if (gmName.length < 2) continue;
      const gmLower = gmName.toLowerCase();
      if (!sentenceLower.includes(gmLower)) continue;

      const escaped = gmName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // 1. MJ as subject performing a game action (not narrative)
      const subjectPattern = new RegExp(
        `(?:le\\s+|l')?${escaped}\\s+`,
        "i"
      );
      const subjectMatch = sentence.match(subjectPattern);
      if (subjectMatch) {
        const afterSubject = sentence.slice(
          (subjectMatch.index ?? 0) + subjectMatch[0].length
        );

        if (gmActionVerbs.test(afterSubject) && !GM_NARRATIVE_VERBS.test(afterSubject)) {
          issues.push(
            `Le MJ agit comme un personnage: "${sentence.slice(0, 120).trim()}…". Le MJ est le narrateur, pas un PJ.`
          );
          continue;
        }
      }

      // 2. MJ + game mechanic term in the same sentence (proximity)
      if (mechanicTermsRe.test(sentence) && !GM_NARRATIVE_VERBS.test(sentence)) {
        const gmIndex = sentenceLower.indexOf(gmLower);
        const mechMatch = sentence.match(mechanicTermsRe);
        if (mechMatch && Math.abs((mechMatch.index ?? 0) - gmIndex) < 120) {
          issues.push(
            `Le MJ est associé à un terme de mécanique de jeu: "${sentence.slice(0, 120).trim()}…". Le MJ ne peut pas utiliser de mécaniques in-game.`
          );
          continue;
        }
      }

      // 3. MJ as object of a game action
      const objectPattern = new RegExp(
        `${gmAsObject.source}${escaped}`,
        "i"
      );
      if (objectPattern.test(sentence)) {
        issues.push(
          `Le MJ est objet d'une action in-game: "${sentence.slice(0, 120).trim()}…". Le MJ ne peut pas être soigné/blessé/etc.`
        );
        continue;
      }

      // 4. MJ with passive game states
      for (const passivePattern of gmPassivePatterns) {
        if (passivePattern.test(sentence)) {
          const gmIdx = sentenceLower.indexOf(gmLower);
          const passiveMatch = sentence.match(passivePattern);
          if (passiveMatch && Math.abs((passiveMatch.index ?? 0) - gmIdx) < 80) {
            issues.push(
              `Le MJ a un état de jeu: "${sentence.slice(0, 120).trim()}…". Le MJ n'a pas d'état in-game.`
            );
            break;
          }
        }
      }
    }
  }

  return [...new Set(issues)];
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
