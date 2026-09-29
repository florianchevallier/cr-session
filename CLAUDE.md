# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CR Session turns recorded tabletop RPG (JDR) sessions into narrative reports ("CR"). The main goal is **getting "who did what" right**. Input is the session audio (preferred), a WhisperX JSON, or a `[SPEAKER_XX]` text transcript. It's a TypeScript monorepo: an Express backend (Gemini, ffmpeg, the user's WhisperX server) and a React frontend, talking over SSE.

## Commands

```bash
npm install                 # both workspaces
npm run dev -w backend      # tsx watch, port 3001
npm run dev -w frontend     # Vite, port 5173 (proxies /api)
npm run build               # backend tsc, then frontend tsc -b + vite
npm run start -w backend    # API + static frontend on port 3001

docker build -t cr-session .   # image includes ffmpeg
docker run -p 3001:3001 --env-file .env cr-session
```

There is no test framework or linter. Quality is measured with the attribution eval bench (below). `ffmpeg`/`ffprobe` must be installed locally.

## Configuration (root `.env`)

- `GOOGLE_API_KEY`: Gemini.
- `WHISPER_API_URL`, `WHISPER_API_KEY`: the user's own WhisperX server (free, behind ngrok). Without `nbSpeaker`/`minSpeakers`/`maxSpeakers`, that server **forces 2 speakers**. The client always sends a speaker count.
- `GEMINI_MODEL_DEFAULT` (default `gemini-3.8-flash`) and `GEMINI_MODEL_<TASK>` for one task (`LEDGER`, `CONSOLIDATE`, `WRITER`, `VERIFIER`, `EDIT`, `EVAL`, `AUDIOREPORT`), read in `config/genai.ts`. Check what the key actually exposes with `GET /v1beta/models` rather than trusting memory. Measured on 2026-09-29: Flash-Lite for consolidation and verification saves only 10% and loses recall, so keep 3.8 Flash everywhere.
- `CR_DATA_DIR` (optional): points the server at another data folder, e.g. a copy of the prod database for a test.
- `GEMINI_PRICES_JSON` (optional): overrides the price table in `config/pricing.ts`.

## Architecture

### Backend layout (`backend/src/`)

- `index.ts`: server bootstrap only (routers, health, static frontend in prod).
- `routes/`:
  - `universes.ts`: universes + editor drafts, exports `safeUniverseId`.
  - `jobs.ts`: create, SSE stream, review, audio excerpts, voice sample from a job.
  - `reports.ts`: list, detail with `cost`, corrections, scenes, rebuild, regenerate.
  - `voiceprints.ts`.
- `jobs/`:
  - `store.ts`: in-memory job queue, resumable SSE, 6 h retention with cleanup of the job folder.
  - `runner.ts`: runs a job, measures cost, saves the report, proposes voice samples.
- `pipeline/`: the only engine, "ledger":

```
audio ─► WhisperX JSON (nbSpeaker = distinct people at the table, initialPrompt = names)
      ─► voice map (SPEAKER_XX → person, constrained to the cast)
      ─► event ledger per 25-min window, 2-min overlap: Gemini hears the AUDIO + reads the timestamped transcript (+ validated voice samples)
      ─► global consolidation (chapters, actor fixes, duplicates, canonical names)
      ─► human review of doubtful attributions (job pauses, status "review")
      ─► chapter writing from the ledger only ─► claim-by-claim verification ─► rewrite if needed
      ─► report/formatter.ts (code, no LLM)
```

- `pipeline/` details:
  - `cast.ts`: cast sheet built from the "Table" rows. Roles are `player` | `gm` | `npc`, plus aliases. Confusable names are detected automatically (Stan ≠ Ekila Stan). When the GM plays a PC, it's a `player` row under the GM's name.
  - `ledger-pipeline.ts`: `analyzeSession` → `reviewItems` / `applyReview` → `writeSession`, plus `rewriteChapter` (scene regeneration). Every stage caches its JSON in the job's `cache/`. Prompt rules learned from real sessions:
    - simultaneous rolls: one event per roller;
    - aliases (Marc = Jet);
    - a player can temporarily play an NPC.
  - `reviewItems`: the model's self-reported confidence is useless (constant). Review is triggered by objective signals: diarization ≠ analysis, action spoken by another player, low confidence. Voice overlap is only a supporting signal.
  - `ledger-job.ts`: orchestration (optional transcription, analysis, review via callback, writing), independent of Express.
  - `voice-suggestions.ts` + `voiceprint-store.ts`: clean speech turns proposed as `pending` voice samples. **Only `confirmed` voiceprints feed the analysis.**
- `report/`:
  - `types.ts`: persisted report state, "Table" rows.
  - `formatter.ts`: markdown with "Chapter N", 🎲/👥/📝 boxes.
  - `editing.ts`: targeted correction, hand-edited scene (boxes re-extracted), regeneration. Always the same policy: the user's instruction wins.
- `config/`:
  - `genai.ts`: native `@google/genai` client (Files API for audio, JSON validated by `zod/v4`, `trackUsage()` for cost via AsyncLocalStorage).
  - `pricing.ts`, `report-style.ts` (format + attribution rules), `database.ts`, `env.ts`, `universes/*.md`.
- `tools/`:
  - `transcription-client.ts`: WhisperX.
  - `transcript-input.ts`: WhisperX JSON or `[SPEAKER_XX]` txt → segments, named transcript `L<n> [Person]`, `extractSceneText`.
  - `audio-windows.ts`: ffmpeg.
- `lib/`: `log.ts`, `http.ts` (disk upload up to 2 GB, latin1→UTF-8 filenames, SSE).

Reports generated before the ledger engine (prod, before 2026-09-30) still open, rebuild, and edit fine. Without a ledger, regeneration works from the transcript alone and is less reliable.

### API

- Jobs:
  - `POST /api/jobs` (multipart `transcript` = audio/.json/.txt, `playerInfo` JSON, `universe*`, `skipReview`) → 202.
  - `GET /api/jobs/:id/stream` (SSE: `step:start|progress|complete`, `review`, `result`, `done`, `error`).
  - `GET|POST /api/jobs/:id/review`.
  - `GET /api/jobs/:id/audio?start&end`.
  - `POST /api/jobs/:id/voiceprints`.
- Voices: `GET|POST /api/universes/:id/voiceprints`, `PATCH|DELETE /api/voiceprints/:id`, `GET /api/voiceprints/:id/audio`.
- Reports: `/api/reports…`. Universes / drafts: `/api/universes…`. `GET /api/health` (`hasApiKey`, `hasTranscription`).

Jobs live in memory: a server restart loses pending jobs, including those in review.

### Data

SQLite `backend/data/cr-session.sqlite` (migrations in `config/database.ts`: `editor_drafts`, `reports`, `report_corrections`, `voiceprints` + `status`). Files: `backend/data/{uploads,jobs,voiceprints,universes}`. Editor drafts live only on the server; the browser only remembers the selected universe.

### Frontend

React 19 + Vite + Tailwind ("parchment" theme). Screens:
- Configuration: `DropZone` for audio or transcript; "Table" (`PlayerForm`: role, aliases, details); "Voices" (`VoiceSamplesPanel`: add, listen, validate/reject/reassign proposed samples).
- Processing: `ProgressPanel` (real stages: transcription, voices, ledger, chapters, review, writing) + `AttributionReview` (listen to the excerpt, pick who acts, keep an excerpt as a voice sample).
- Report: `ReportViewer`.

`useSSE` handles the `review` event.

## Attribution eval bench (`backend/scripts/`, data in `backend/eval/data/`, gitignored)

```bash
cd backend
npx tsx scripts/transcribe.ts <audio> eval/data/<id>.whisperx.json <nbSpeaker> "<initialPrompt>"
npx tsx scripts/run-variant.ts B|C --session <id> [--model m]     # B audio-only Gemini, C ledger; writes cost
npx tsx scripts/eval-attribution.ts gold --session <id>           # "who did what" claims from <id>.reference.md
npx tsx scripts/eval-attribution.ts judge eval/data/results/<n>.md <n> --session <id>
npx tsx scripts/eval-attribution.ts table|disputes --session <id>
npx tsx scripts/arbitrate-disputes.ts --session <id> --voices <cache>/voices.json [--min 1]   # locate + cut + listen to each dispute
npx tsx scripts/propose-voiceprints.ts --session <id> --voices <cache>/voices.json
```

Each session needs `<id>.cast.json`, `<id>.reference.md` (reference CR), and optionally `<id>.history.md`. **Reference CRs can be AI-generated and wrong**: settle `disputes` by listening to the audio (cut the excerpt and let the user listen), never by trusting the reference. The judge (temperature 0) is stable; the noise comes from generation: two runs of the same engine differ by about ±3 points, so compare averages over several runs.

## Deployment

- Host: `ssh lepaladin`, container `cr-session`, defined in `~/docker/compose/websites/cr-session.paladin.ovh.yml` (Traefik, `https://cr-session.paladin.ovh`, no auth, volume `cr_session_data` → `/app/backend/data`).
- A `v*.*.*` tag pushed to GitHub runs `.github/workflows/deploy.yml`. It builds the `prod` image, pushes it to `registry.paladin.ovh/cr-session`, then triggers Watchtower (`wt.paladin.ovh`).
- Container env: `GOOGLE_API_KEY`, `GEMINI_MODEL_DEFAULT`, `WHISPER_API_URL`, `WHISPER_API_KEY`, `TZ`.

## Key Patterns

- ESM throughout, `.js` extensions in backend imports.
- Zod `zod/v4` everywhere (`z.toJSONSchema` for Gemini structured output).
- Ledger prompts live in `pipeline/ledger-pipeline.ts`; the report format and attribution rules live in `config/report-style.ts`; universe lore is markdown in `config/universes/`.

## Limitation
- NEVER COMMIT on my behalf
- NEVER CREATE documentation without my approval
