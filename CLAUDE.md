# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Watapp is a full-stack application with a monorepo structure containing:
- **web** — Next.js (TypeScript) frontend
- **mobile** — React Native / Expo app (TypeScript)
- **api** — Python backend (FastAPI or Django)
- **infra** — Docker Compose orchestration

## Intended Stack

| Layer | Technology |
|-------|-----------|
| Web frontend | Next.js + TypeScript |
| Mobile | React Native + Expo + TypeScript |
| Backend API | Python (FastAPI preferred, or Django REST) |
| Database | PostgreSQL (SQL) or MongoDB (NoSQL) — TBD |
| Containerisation | Docker Compose |

## Expected Monorepo Layout

```
/
├── web/          # Next.js app
├── mobile/       # Expo app
├── api/          # Python API
├── docker-compose.yml
└── CLAUDE.md
```

## Common Commands (once bootstrapped)

### Docker (all services)
```bash
docker compose up --build      # start everything
docker compose down            # stop everything
docker compose logs -f api     # tail a specific service
```

### Web (Next.js)
```bash
cd web
npm install
npm run dev        # dev server on http://localhost:3000
npm run build
npm run lint
npm run test
```

### Mobile (Expo)
```bash
cd mobile
npm install
npx expo start          # launch Expo dev server
npx expo run:ios
npx expo run:android
```

### API (Python / FastAPI)
```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload   # dev server on http://localhost:8000
pytest                       # run tests
pytest tests/test_foo.py     # single test file
```

## Architecture Notes

- The web and mobile clients both talk to the Python API; do not duplicate business logic in the frontends.
- Docker Compose wires the services together for local development; each service should also be runnable standalone for faster iteration.
- TypeScript strict mode should be enabled in both `web/` and `mobile/` from the start.
- Environment variables are managed via `.env` files per service (never committed); use `.env.example` files as templates.
