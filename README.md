# Gonya

A personal AI workspace with named agents, real-time group chat and low-latency voice calls. Live at [app.leuenaar.my.id](https://app.leuenaar.my.id).

Gonya is a portfolio project. It was built by directing an AI coding assistant (Claude) through the full lifecycle of a non-trivial system: data modelling, auth, real-time infrastructure, multi-provider AI orchestration and streaming voice. I write the requirements, review the output, test it and make the architectural calls. I do not hand-write or read the source line by line, and this repo does not pretend otherwise. It has no paying users.

- Built by: [Harva Heru](https://www.leuenaar.my.id/)
- Stack: React 18, Vite, TypeScript, Node.js, Express, Supabase (Postgres, Auth, Realtime), Redis, Deepgram, Google Cloud TTS
- Status: V1 live. One known open issue, listed under [Known issues](#known-issues).

## What it does

- **Two agents with different jobs.** Aksel is the execution-focused persona (Groq, `gpt-oss` models). Vera is the research and depth persona (Anthropic Claude). In group chats a selection layer decides whether one or both should answer.
- **Onboarding orchestrator (TheOnes).** Runs once per user and configures the workspace.
- **Personal and group chat** with per-request interrupt and cancel, reactions, delete-for-everyone and attachments.
- **Real-time voice calls** with streamed speech-to-text (Deepgram) and text-to-speech (Deepgram, plus Google Cloud TTS for Indonesian). Desktop and mobile run as two separate pipelines.
- **Demo mode.** Anonymous Supabase auth, a visible "Demo Mode" badge and automatic deletion after 30 days.
- **Memory.** Per-user and per-group memory with vector search (pgvector, Voyage embeddings).
- **Safety layer.** Crisis detection with a curated resources endpoint, age-pattern detection and a group message judge.
- **Bilingual.** Indonesian and English interface and voice.
- **Utilities.** Tasks, notes, calendar, USD/IDR conversion, macro news, file uploads and generated documents (DOCX, XLSX, PDF).

## Architecture

```
Browser (React + Vite)
   |  HTTPS /api/*            |  WSS /ws/*  (voice)        |  Supabase Realtime (chat events)
   v                          v                            v
Nginx ------> Node/Express backend (PM2) ------> Supabase (Postgres + Auth + Realtime)
                 |   |   |
                 |   |   +--> Redis (sessions, rate limits)
                 |   +------> LLMs: Groq, Anthropic, Voyage (embeddings)
                 +----------> Speech: Deepgram (STT/TTS), Google Cloud TTS
```

| Folder | What is in it |
|---|---|
| `frontend/` | React 18 + Vite + TypeScript client |
| `backend/` | Express API, voice WebSocket servers, agent orchestration, cron jobs, safety layer |
| `database/schema/` | The full Postgres schema as six ordered SQL files |
| `docs/` | Design notes and case studies |

Backend layout:

| Path | Purpose |
|---|---|
| `chat/` | Message handling and the group triggers (Aksel, Vera, idle, batching) |
| `theones/` | Agent registry, onboarding orchestrator, group orchestrator |
| `voice/` | Separate desktop and mobile voice session servers, plus voice generation |
| `safety/` | Crisis detector, resources, group judge, age patterns |
| `lib/` | Provider clients (Anthropic, Groq, Deepgram, Voyage, Redis, Supabase), memory, file generation |
| `routes/` | REST routes, one file per area |
| `cron/` | Daily global-events scan (00:00 UTC) and demo-account cleanup (01:00 UTC) |
| `middleware/` | Auth (JWT plus trusted-device gate) and rate limiting |

## Quick start

You need Node.js 18 or newer, a Supabase project, a Redis instance and API keys for the providers listed below. Several of them are required at boot, so the server will not start without them.

### 1. Database

Create a Supabase project, open the SQL Editor and run the files in `database/schema/` in numeric order, `1_extensions.sql` through `6_policies.sql`. Details and caveats are in [`database/README.md`](database/README.md).

### 2. Backend

```bash
cd backend
cp .env.example .env      # fill in the values
npm install
npm run dev               # nodemon, or: npm start
```

The API listens on `http://localhost:3000`. Check `GET /api/health`.

Required at boot: Supabase, Redis, Anthropic, Groq, Deepgram, Tavily, Google TTS credentials and Resend. Voyage is needed for memory. Cloudinary and Guardian are optional. Every variable is documented in `backend/.env.example`. Groq, Deepgram and Tavily accept several numbered keys (`GROQ_API_KEY_1`, `GROQ_API_KEY_2`, ...) and rotate when one is rate limited.

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local   # Supabase URL, anon key, backend URL
npm install
npm run dev                  # http://localhost:5173
```

The Vite dev server proxies `/api` to `VITE_API_URL`.

### Scripts

| Where | Command | What it does |
|---|---|---|
| `backend/` | `npm run dev` | Start with nodemon |
| `backend/` | `npm start` | Start with node |
| `backend/` | `node backfill-usernames.js` | One-off: assign usernames to accounts created before eager assignment |
| `frontend/` | `npm run dev` | Vite dev server on port 5173 |
| `frontend/` | `npm run build` | Production build into `dist/` |
| `frontend/` | `npm run typecheck` | `tsc --noEmit` (see Known issues) |

## Deployment model

Gonya runs on a single self-managed VPS with no CI pipeline. The frontend build is copied over with `scp`, the backend runs under PM2, and Nginx splits `/api/` and `/ws/` traffic (`/ws/voice` for desktop, `/ws/voice-mobile` for mobile) to the same Node process. This is deliberately simple for a portfolio-scale project. A CI-driven deploy is the obvious next step before real traffic.

## Engineering notes

### Case study A: real-time messages that sometimes did not arrive

**Symptom.** Chat messages, reactions, deletions and attachments reach open clients through Supabase Realtime. Under some conditions an event was never delivered. The failure shows up as an absence, not an error, so it is hard to catch.

**Cause.** The application layer was emitting the broadcast after the write, which leaves a window where the write succeeds and the event is dropped, delayed or raced.

**Fix: Broadcast-from-Database.** Postgres trigger functions (`SECURITY DEFINER`) call `realtime.broadcast_changes()` inside the same transaction that writes the row. If the row commits, the event fires. The pattern now covers personal messages, group messages, reactions, deletions and attachments. See `database/schema/4_functions.sql` and `5_triggers.sql`.

**Verification.** Multi-window and reconnect testing across every surface, not one manual check.

### Case study B: voice calls that died on mobile

**Symptom.** On mobile, calls failed after one or two exchanges. The microphone level meter kept moving, but speech stopped reaching the transcript, with no visible error.

**Process.**
1. Four hypotheses were tested and ruled out one at a time: screen-lock audio interruption, a flickering `isMobile` state re-initialising the client mid-call, a missing silent-audio keepalive, and a one-minute pattern that looked like API key rotation.
2. The original working voice session from earlier in the project was restored and tested in isolation. It ran stable on desktop for about three minutes of multi-exchange conversation, which showed the core pipeline was sound.
3. Because desktop was proven stable, mobile was built as a fully separate pipeline (`voiceSessionMobile.js`) so mobile experiments could not break desktop again.
4. A real defect was then found in the mobile path: the Deepgram WebSocket reconnect handler was attached only to the first socket, so a reconnect lost it.

**Outcome.** Desktop is stable. Mobile is much better but not fully solved (see below). The barge-in feature was reversed after it proved unreliable.

## Known issues

- **Mobile voice on Chrome for Android is still unstable** in some sessions. This is the one open problem. The investigation notes are in Case study B above.
- **`npm run typecheck` reports type errors.** The Vite build does not depend on them, so `npm run build` succeeds, but the types need a cleanup pass.
- **Some diagnostic code is still in place** from the mobile voice investigation (`frontend/src/lib/remoteLog.ts` and related calls). The server-side receiver (`/api/debug-log`) is off unless `ENABLE_CLIENT_DEBUG=true`.
- **No automated test suite yet.** Verification so far has been live manual and multi-window testing.
- **No CI/CD.** Deploys are manual.

## How this was built

Every feature followed the same loop: research the problem first, write a short design, get my approval, let the AI implement it, then test it live before moving on. Bugs were handled by evidence, not by stacking guesses, which is why Case study B lists the hypotheses that were eliminated and not only the one that held. If you are reviewing this as a hiring manager or client, the engineering notes above are the best picture of how I work.

## License

No license has been chosen yet. All rights reserved until one is added. The code is public so it can be reviewed.
