# CR Session — Transcripts JDR vers Comptes-Rendus

Transforme automatiquement les transcripts de sessions de Jeu de Rôle en comptes-rendus structurés et narratifs, via une pipeline multi-agent LangGraph + Gemini.

## Architecture

```
Transcript brut
  |
  v
[Preprocessor] ── nettoyage, numérotation, détection patterns (code pur)
  |
  v
[Analyst Agent] ── détection scènes, speakers, entités (Gemini 2.5 Pro)
  |
  v
[Summarizer Node] ── résumé narratif par scène, parallélisé (Gemini 2.0 Flash)
  |
  v
[Validator Node] ── vérification cohérence (Gemini 2.0 Flash)
  |  \
  |   v (si erreurs)
  |  [Summarizer] ── correction des scènes problématiques
  |
  v
[Formatter Node] ── mise en forme markdown hybride (Gemini 2.0 Flash)
  |
  v
Compte-rendu structuré (.md)
```

## Prérequis

- **Node.js** >= 18
- **npm** >= 9
- Une **clé API Google** (Gemini) : [Obtenir une clé](https://aistudio.google.com/apikey)

## Installation

```bash
# Cloner et installer
cd cr-session
npm install

# Configurer la clé API
cp .env.example .env  # ou éditer .env directement
# Ajouter : GOOGLE_API_KEY=ta-clef-ici
```

## Utilisation

```bash
# Lancer le backend (port 3001)
npm run dev -w backend

# Lancer le frontend (port 5173)
npm run dev -w frontend
```

Ouvrir http://localhost:5173

## Docker

### Lancer en local avec Docker Compose

```bash
cp .env.example .env
# renseigner GOOGLE_API_KEY dans .env

docker compose up --build
```

Application disponible sur http://localhost:3001

### Donnees persistantes

Le volume `cr_session_data` conserve:
- Les brouillons editeur (`backend/data/editor-drafts`)
- Les univers personnalises (`backend/data/universes`)

## CI/CD (GitHub Actions)

- `ci.yml`: verification sur chaque push/PR (install, build, build Docker sans push)
- `deploy.yml`: sur tag semver `v*.*.*`, build+push image Docker vers le registry perso
- Le workflow de deploy attend ces secrets:
  - `REGISTRY_USERNAME`
  - `REGISTRY_PASSWORD`
  - `UPDATE_TOKEN`

## Interface

1. **Drop** ton fichier transcript (.txt)
2. **Choisis** l'univers (Mage, Thyléa, ou générique)
3. **Édite** le pre-prompt / lore si nécessaire
4. **Ajoute** les joueurs (nom + personnage + speaker ID optionnel)
5. **Lance** la génération et suis la progression en temps réel

## Univers supportés

- **Mage: L'Ascension** — World of Darkness, sphères, paradoxe
- **Thyléa** — Odyssey of the Dragonlords, D&D 5e, mythologie grecque
- **Générique** — Tout JDR, détection automatique du système

## Stack technique

- **Backend** : Node.js, TypeScript, Express, LangGraph, Gemini (via @langchain/google-genai)
- **Frontend** : React, Vite, Tailwind CSS
- **Streaming** : Server-Sent Events (SSE)

## Structure

```
cr-session/
├── backend/
│   └── src/
│       ├── agents/        # Analyst, Summarizer, Validator, Formatter
│       ├── config/        # Prompts, LLM config, fichiers univers
│       ├── graph/         # StateGraph LangGraph + state Zod
│       └── tools/         # Preprocessing (code pur)
├── frontend/
│   └── src/
│       ├── components/    # DropZone, UniverseSelector, PlayerForm, etc.
│       └── hooks/         # useSSE pour le streaming
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── Dockerfile
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env                   # GOOGLE_API_KEY
```
