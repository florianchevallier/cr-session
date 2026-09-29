/**
 * Format et style des comptes-rendus, partagés par le rédacteur audio et le pipeline registre.
 * Calqué sur les CR que l'utilisateur juge bons (chapitres + encadrés 🎲 / 👥 / 📝).
 */
export const REPORT_FORMAT_INSTRUCTIONS = `FORMAT DU COMPTE-RENDU (markdown, en français) :

# Session N - <titre évocateur>   (si le numéro est inconnu, omets « Session N - »)

## Chapitre K : <titre évocateur de 6 à 14 mots>

*📍 <lieu(x) du chapitre>*

<Narration au présent de narration, dense, immersive, 3 à 10 paragraphes.
 Les PJ sont les sujets de leurs actions ; chaque sort cite la ou les Sphères utilisées et, entre parenthèses,
 le nombre de succès quand il est connu. Les répliques marquantes sont citées en italique : *« … »*.
 Le MJ n'apparaît JAMAIS : sa narration devient le monde, ses PNJ parlent en leur nom.
 Le hors-jeu (blagues de table, règles, pauses) n'apparaît pas, sauf s'il éclaire une action.>

---

> **🎲 Jets de dés**
>
> - **<Personnage>** — <Trait / Sphères> : **<résultat : N succès / Échec / Échec critique / Succès automatique / narratif>** *(dés si connus, difficulté)* — *<but de l'action>*

---

> **👥 PNJs impliqués**
>
> - **<PNJ>** : <rôle dans ce chapitre>

---

> **📝 Notes techniques**
>
> - **<Mécanique>** : <explication règles / univers>

Découpe en chapitres selon les grands mouvements de la session (lieu, objectif, combat), en général 4 à 8 chapitres.`;

export const ATTRIBUTION_RULES = `RÈGLES D'ATTRIBUTION (les plus importantes de toutes) :
1. Chaque action est attribuée au personnage qui la réalise DANS LA FICTION. Un joueur parle pour son personnage ;
   le MJ parle pour le monde et pour TOUS les PNJ (et pour tout PJ qu'on lui a confié).
2. Distingue l'intention (« je vais… », « je voudrais… », « est-ce que je peux… ») du fait : n'écris comme accompli
   que ce qui est confirmé par la suite (jet réussi, description du MJ). Une idée abandonnée n'est pas une action.
3. Ce que le MJ décrit (« tu vois… », « il te dit… », « elle rentre… ») arrive AU personnage interpellé ou est fait
   par un PNJ : ce n'est jamais une action d'un PJ.
4. Un personnage absent de la scène n'agit pas. Ne confonds jamais deux personnages aux noms proches.
5. En cas de doute réel sur qui agit, préfère une formulation neutre ou collective plutôt qu'une attribution inventée.`;
