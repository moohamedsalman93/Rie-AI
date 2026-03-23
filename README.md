# Rie-AI

Desktop client (Tauri + React) and Python backend for the Rie-AI assistant.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE).

## Repository layout

| Path | Description |
|------|-------------|
| `client/` | Tauri v2 app and Vite + React UI |
| `server/` | FastAPI backend (Poetry) |

## Prerequisites

- **Node.js** (LTS) and npm
- **Rust** toolchain (for Tauri): [rustup](https://rustup.rs/)
- **Python 3.11** and [Poetry](https://python-poetry.org/) for the backend

## Quick start

### 1. Backend

```bash
cd server
poetry install
poetry run python main.py
```

The API listens on `http://127.0.0.1:8000` by default.

### 2. Desktop app

```bash
cd client
npm install
npm run tauri:dev
```

Use `npm run tauri:staging` if you need the full Tauri dev experience without the dev-only shortcut from `tauri:dev`.

### Build the app

```bash
cd client
npm run build
npm run tauri:build
```