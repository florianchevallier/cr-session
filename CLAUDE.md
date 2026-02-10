# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CR Session transforms RPG (JDR) session transcripts into structured narrative reports using a multi-agent LangGraph pipeline powered by Google Gemini. It's a TypeScript monorepo with an Express backend and React frontend communicating via SSE streaming.

## Commands

```bash
# Install dependencies (both workspaces)
npm install

# Development (run in separate terminals)
npm run dev -w backend     # tsx watch, port 3001
npm run dev -w frontend    # Vite dev server, port 5173 (proxies /api to backend)

# Production build
npm run build              # builds backend (tsc) then frontend (vite)
npm run start -w backend   # serves API + static frontend on port 3001

# Docker
docker build -t cr-session .
docker run -p 3001:3001 -e GOOGLE_API_KEY=key cr-session
```

No test framework or linter is configured.

## Architecture

### Multi-Agent Pipeline (LangGraph)

The core pipeline is defined in `backend/src/graph/workflow.ts` as a LangGraph `StateGraph`:

```
START → preprocessor → analyst → summarizer → validator → formatter → END
                                     ↑              |
                                     └── (retry if errors, max 2) ──┘
```

- **Preprocessor** (`tools/preprocessing.ts`): Pure code - line numbering, speaker detection, dice roll patterns. No LLM.
- **Analyst** (`agents/analyst.ts`): Scene detection, speaker mapping (SPEAKER_XX → player names), entity extraction. Uses Gemini Flash ("pro" variant).
- **Summarizer** (`agents/summarizer.ts`): Narrative summary per scene, processes scenes sequentially. Uses Gemini Flash Lite ("flash" variant).
- **Validator** (`agents/validator.ts`): Checks fidelity/completeness/coherence per scene. Can route back to Summarizer (max 2 retries).
- **Formatter** (`agents/formatter.ts`): Assembles final markdown report with timeline, narrative sections, technical boxes, annexes.

### State Management

`backend/src/graph/state.ts` defines the full workflow state using `Annotation.Root` with Zod schemas for structured LLM outputs. The `sceneSummaries` reducer merges by sceneId to support retry updates.

### LLM Configuration

`backend/src/config/llm.ts` - `createModel("pro")` → `gemini-3-flash-preview`, `createModel("flash")` → `gemini-flash-lite-latest`. API key loaded from root `.env`.

### Streaming

The backend streams progress via SSE on `POST /api/process`. The frontend consumes it with `useSSE` hook (`frontend/src/hooks/useSSE.ts`). Events include `update` (step progress) and `custom` (scene-level granularity).

### Universe System

Bundled universe lore files in `backend/src/config/universes/` (Mage, Thylea, Generic as markdown). Custom universes stored in `backend/data/universes/`. Universe context is injected into agent prompts.

### API Endpoints (backend/src/index.ts)

- `GET /api/universes` - List available universes
- `POST /api/universes` - Create custom universe
- `GET/PUT /api/universes/:id/draft` - Universe draft persistence
- `POST /api/process` - Main SSE endpoint (multipart: transcript file + config JSON)
- `GET /api/health` - Health check

### Frontend

React 19 + Vite + Tailwind with a custom "parchment" theme. 3-step wizard: configure (file + universe + players) → processing (real-time SSE progress) → result (markdown report). Report history persisted in localStorage.

## Key Patterns

- **ESM throughout**: Both workspaces use `"type": "module"`. Imports use `.js` extensions in backend source.
- **Zod for structured outputs**: All LLM responses validated via Zod schemas compatible with Gemini's structured output mode.
- **State reducers**: LangGraph state uses last-write-wins (`(_, b) => b`) except `sceneSummaries` (merge by ID) and `messages` (append).
- **Prompts in config**: All system prompts centralized in `backend/src/config/prompts.ts`. Universe lore is separate markdown files.
