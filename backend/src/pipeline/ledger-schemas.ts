/**
 * Schémas du pipeline « registre d'événements ».
 * Tout ce qui est attribué porte sa preuve (segments, citation) et une confiance.
 */
import { z } from "zod/v4";

export const VoiceMapSchema = z.object({
  voices: z.array(
    z.object({
      speakerId: z.string().describe("SPEAKER_XX de la diarization"),
      mainPerson: z.string().describe("personne réelle majoritaire derrière cette voix (prénom du joueur ou du MJ)"),
      share: z.number().describe("part estimée des segments de cette voix qui sont bien cette personne, 0-1"),
      alsoContains: z.array(z.string()).describe("autres personnes souvent fondues dans cette voix"),
      evidence: z.string(),
    })
  ),
});
export type VoiceMap = z.infer<typeof VoiceMapSchema>;

export const RollSchema = z.object({
  traits: z.string().describe("Trait / Sphères / Arété utilisés, ex. 'Arété (Psyché 2)'"),
  result: z.string().describe("ex. '3 succès', 'Échec', 'Échec critique', 'Succès automatique / narratif'"),
  dice: z.string().describe("valeurs des dés si énoncées, ex. '7, 5, 9' ; '' sinon"),
  difficulty: z.string().describe("difficulté/seuil si énoncé ; '' sinon"),
});

export const EventSchema = z.object({
  segIds: z.array(z.number().int()).describe("numéros des segments du transcript qui prouvent l'événement"),
  actor: z
    .string()
    .describe("personnage qui agit dans la fiction : nom canonique du PJ ou nom du PNJ (jamais 'monde' si quelqu'un agit)"),
  actorType: z
    .enum(["PJ", "PNJ", "monde"])
    .describe("'monde' UNIQUEMENT pour une description sans agent (lieu, ambiance) ; un PNJ qui agit est 'PNJ'"),
  spokenBy: z.string().describe("personne réelle qui parle (joueur ou MJ) d'après la voix et le contexte"),
  action: z.string().describe("ce qui se passe, une à deux phrases précises, au présent"),
  status: z.enum(["réussi", "raté", "tenté", "intention_abandonnée", "information", "dialogue"]),
  roll: RollSchema.nullable(),
  quote: z.string().describe("réplique marquante en fiction à citer telle quelle, '' sinon"),
  location: z.string(),
  present: z.array(z.string()).describe("PJ présents dans la scène à ce moment"),
  confidence: z.number().describe("confiance dans l'attribution de l'acteur, 0-1"),
  evidence: z.string().describe("indices d'attribution : vocatif, voix, annonce de jet, sphère, réponse du MJ…"),
});
export type LedgerEvent = z.infer<typeof EventSchema> & { id: string; t: number; window: number };

export const WindowLedgerSchema = z.object({
  events: z.array(EventSchema),
  speakerCorrections: z
    .array(
      z.object({
        segId: z.number().int(),
        person: z.string().describe("personne réelle qui parle vraiment dans ce segment"),
        reason: z.string(),
      })
    )
    .describe("segments où l'étiquette de voix est fausse d'après l'audio et le contexte"),
  stateSummary: z
    .string()
    .describe("état à la fin de la fenêtre : lieu, qui est où, objectifs en cours, menaces, PNJ présents"),
});
export type WindowLedger = z.infer<typeof WindowLedgerSchema>;

export const ConsolidationSchema = z.object({
  title: z.string().describe("titre évocateur de la séance"),
  chapters: z.array(
    z.object({
      title: z.string().describe("titre évocateur, casse de phrase"),
      location: z.string(),
      synopsis: z.string().describe("résumé factuel du chapitre en 2 phrases"),
      eventIds: z.array(z.string()),
      npcs: z.array(z.object({ name: z.string(), role: z.string() })),
      technicalNotes: z.array(z.object({ label: z.string(), text: z.string() })),
    })
  ),
  fixes: z
    .array(
      z.object({
        eventId: z.string(),
        actor: z.string().describe("acteur corrigé, '' si inchangé"),
        status: z.string().describe("statut corrigé, '' si inchangé"),
        drop: z.boolean().describe("true si l'événement est un doublon ou du hors-jeu à retirer"),
        reason: z.string(),
      })
    )
    .describe("corrections d'incohérences entre fenêtres : acteur, statut, doublons"),
  canonicalNames: z
    .array(z.object({ variant: z.string(), canonical: z.string() }))
    .describe("variantes orthographiques de noms → forme canonique"),
});
export type Consolidation = z.infer<typeof ConsolidationSchema>;

export const VerificationSchema = z.object({
  issues: z.array(
    z.object({
      sentence: z.string().describe("phrase fautive du texte"),
      problem: z.enum(["mauvais_acteur", "non_soutenu", "intention_comme_fait", "personnage_absent", "mj_mentionne", "omis"]),
      fix: z.string().describe("correction à appliquer"),
    })
  ),
});
export type Verification = z.infer<typeof VerificationSchema>;
