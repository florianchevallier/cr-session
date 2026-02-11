# Édition de scènes - Guide utilisateur

## Vue d'ensemble

La fonctionnalité d'édition de scènes permet de modifier directement le contenu narratif de chaque scène d'un compte-rendu généré, avec une interface fluide et intuitive.

## Fonctionnalités

### ✨ Interface utilisateur

- **Section collapsible** : Une section dédiée "Éditer les scènes" apparaît au-dessus du rapport
- **Preview des scènes** : Chaque scène affiche un aperçu de son contenu narratif
- **Bouton d'édition** : Un bouton "Éditer" apparaît au survol de chaque scène

### 🎨 Mode édition

- **Éditeur inline** : Le contenu de la scène est remplacé par un éditeur de texte
- **Auto-resize** : La zone de texte s'adapte automatiquement à la taille du contenu
- **Raccourcis clavier** :
  - `⌘/Ctrl + Entrée` : Sauvegarder les modifications
  - `Échap` : Annuler et quitter le mode édition

### 💾 Sauvegarde

- **Regénération automatique** : Le rapport complet est régénéré après chaque modification
- **Feedback visuel** : Notification "Sauvegardé !" avec animation
- **Mise à jour instantanée** : Le rapport affiché est mis à jour sans rechargement

## Architecture technique

### Backend

#### Endpoints API

```typescript
// Récupérer toutes les scènes d'un rapport
GET /api/reports/:reportId/scenes
Response: { scenes: SceneWithSummary[] }

// Mettre à jour une scène
PUT /api/reports/:reportId/scenes/:sceneId
Body: { narrativeSummary: string }
Response: { reportId: string, sceneId: number, reportMd: string }
```

#### Workflow

1. Récupération de la scène depuis le `workflowState` du rapport
2. Mise à jour du `narrativeSummary` dans `sceneSummaries`
3. Régénération du rapport via `formatterNode`
4. Sauvegarde du nouveau rapport dans la base de données

### Frontend

#### Composants

- **`SceneEditor`** : Composant réutilisable pour éditer une scène
  - Props : `sceneId`, `title`, `content`, `onSave`, `isSaving`
  - États : `isEditing`, `editedContent`, `showSaveSuccess`

- **`ReportViewer`** : Intègre les éditeurs de scènes
  - Charge les scènes via `fetchScenes(reportId)`
  - Gère la sauvegarde via `updateScene(reportId, sceneId, content)`

#### Types TypeScript

```typescript
interface SceneMeta {
  id: number;
  title: string;
  type: string;
  startLine: number;
  endLine: number;
  location?: string;
}

interface SceneSummary {
  sceneId: number;
  narrativeSummary: string;
  keyEvents: string[];
  diceRolls: Array<{
    character: string;
    skill: string;
    result: string;
    context: string;
  }>;
  npcsInvolved: string[];
  technicalNotes?: string[];
}

interface SceneWithSummary extends SceneMeta {
  summary: SceneSummary | null;
}
```

## Animations et UX

### Transitions fluides

- **Fade-in** : Apparition de la section des scènes
- **Scale-in** : Ouverture du mode édition
- **Hover effects** : Surbrillance des scènes au survol
- **Success pulse** : Animation de confirmation après sauvegarde

### Feedback visuel

- **Toast notifications** : Notification de sauvegarde en haut à droite
- **Bouton d'état** : Le bouton "Sauvegarder" affiche un spinner pendant le traitement
- **Preview/Edit toggle** : Transition fluide entre les modes

## Améliorations futures possibles

1. **Historique des modifications** : Voir l'historique des éditions et pouvoir revenir en arrière
2. **Édition collaborative** : Permettre plusieurs utilisateurs d'éditer simultanément
3. **Suggestions IA** : Proposer des améliorations au contenu narratif
4. **Export différentiel** : Exporter uniquement les scènes modifiées
5. **Validation de contenu** : Vérifier la cohérence avec le reste du rapport

## Notes techniques

- Les scènes de type `meta` et `pause` ne sont pas éditables
- La régénération du rapport préserve la structure et les métadonnées
- Le `workflowState` complet est persisté pour permettre les regénérations
- Les modifications sont sauvegardées dans SQLite pour la persistence
