# Rie-AI

<p align="center">
  <strong>Desktop-first AI assistant powered by Tauri + React + FastAPI</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/python-3.11.9-blue.svg" alt="Python 3.11.9">
  <img src="https://img.shields.io/badge/node-LTS-339933.svg" alt="Node LTS">
  <img src="https://img.shields.io/badge/tauri-v2-8A2BE2.svg" alt="Tauri v2">
  <img src="https://img.shields.io/badge/react-19-149ECA.svg" alt="React 19">
</p>

Rie-AI is an open-source desktop AI assistant with a lightweight floating UI, streaming chat, voice features, automation tooling, scheduling, and local-first persistence.

---

## Table of contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Build and release](#build-and-release)
- [Configuration](#configuration)
- [API overview](#api-overview)
- [Data and logs](#data-and-logs)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Highlights

- Floating always-on-top desktop assistant window
- Real-time streaming chat responses with cancel support
- Voice input/output endpoints (transcribe + speak)
- Local chat history, threads, settings, and scheduler persistence (SQLite)
- Configurable providers and models (Groq, Gemini/Vertex, OpenAI-compatible, Ollama, Rie)
- MCP integrations and external API support
- Packaged Python backend sidecar for distribution

## Architecture

Rie-AI is split into two parts:

1. **Desktop client** (`client/`)
   - Tauri v2 host + React frontend
   - Handles UI, user interactions, and desktop lifecycle
2. **Backend API** (`server/`)
   - FastAPI application with agent/tool orchestration
   - Handles chat streaming, settings, history, scheduler, and integrations

## Tech stack

- **Desktop:** Tauri v2, React 19, Vite, Tailwind CSS
- **Backend:** FastAPI, Uvicorn, Poetry
- **Persistence:** SQLite (settings/history/scheduler/checkpoints)
- **AI ecosystem:** LangChain tooling + multiple LLM providers

## Project structure

| Path | Description |
|------|-------------|
| `client/` | Tauri app and React frontend |
| `client/src-tauri/` | Tauri/Rust config, sidecar setup, packaging |
| `server/` | FastAPI backend and Python runtime |
| `server/app/` | Core modules (`routes`, `agent`, `tools`, `database`, etc.) |

## Quick start

### Prerequisites

- Node.js LTS + npm
- Python `3.11.9`
- Poetry
- Rust via [rustup](https://rustup.rs/)
- OS-specific Tauri prerequisites: [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### 1) Start backend

```bash
cd server
poetry install
poetry run uvicorn main:app --reload
```

Backend runs on `http://127.0.0.1:8000`.

### 2) Start desktop app

```bash
cd client
npm install
npm run tauri:dev
```

Useful scripts:

- `npm run tauri:dev` - dev mode with sidecar shortcut (`SKIP_SIDECAR=true`)
- `npm run tauri:staging` - regular Tauri development flow

## Build and release

### Production build

```bash
cd client
npm run build
npm run tauri:build
```

### Release helper

```bash
cd client
npm run release
```

## Configuration

Most runtime configuration is stored in SQLite and updated through app settings / backend settings endpoints.

### Environment variables

- `DEBUG` - `true` or `false`
- `RIE_APP_TOKEN` - optional request token, validated via `X-Rie-App-Token`

If `RIE_APP_TOKEN` is not set, token validation is skipped for local/dev workflows.

### Provider and integration settings (stored in DB)

Common keys:

- `GROQ_API_KEY`
- `GOOGLE_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `TAVILY_API_KEY`
- `RIE_ACCESS_TOKEN`
- `OLLAMA_MODEL`, `OLLAMA_API_URL`, `OLLAMA_API_KEY`
- `LLM_PROVIDER` and model preferences

## API overview

Main endpoint groups include chat, audio, settings, history, scheduler, logs, and health.

Key routes:

- `POST /chat/stream` - stream assistant responses
- `POST /chat/cancel` - cancel active generation
- `GET /settings` / `POST /settings` - get/update settings
- `GET /history` / `GET /history/{thread_id}` / `DELETE /history/{thread_id}`
- `POST /audio/transcribe` / `POST /audio/speak`
- `POST /scheduler/schedule` / `GET /scheduler/tasks`
- `GET /` - health check

## Data and logs

- Dev database path: `server/settings.db`
- Packaged mode data path: local app data under `Rie-AI/`
- Dev backend log file: `backend_debug.log`

## Security

- Never commit real API keys or tokens
- Set `RIE_APP_TOKEN` for non-local deployments
- Review enabled tools and terminal restrictions before distribution

## Troubleshooting

- **Backend fails to start**
  - Confirm Python is `3.11.9`
  - Re-run `poetry install`
- **Tauri build fails**
  - Verify Rust toolchain and platform prerequisites
- **UI cannot connect to backend**
  - Confirm backend is running at `127.0.0.1:8000`
  - Restart client and backend after major settings changes
- **Provider unavailable**
  - Validate provider keys/model names in settings

## Contributing

Contributions are welcome.

1. Fork the repo
2. Create a branch (`feat/...`, `fix/...`, etc.)
3. Keep changes focused and documented
4. Open a PR with:
   - problem statement
   - approach
   - verification steps

## License

MIT License. See [`LICENSE`](LICENSE).