# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Watapp (deployed as **CRM**) is a **multi-channel outreach & recruitment CRM**. It drives WhatsApp (multiple numbers) and Telegram conversations through a recruitment pipeline — from cold outreach to a signed associate agreement and onboarding.

> Note: despite the old bootstrap notes, there is **no `mobile/` or Python `api/`** here. The real app is a Node backend + a Next.js web UI.

## Actual Stack & Layout

| Layer | Technology |
|-------|-----------|
| Backend | **Node.js** — `server/index.js` (Express + [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp + Telegram long-poll). Container `crm-server`, internal port `10001`. |
| Web | **Next.js + TypeScript** — `web/`. Container `crm-web`, port `10000`. |
| AI | Anthropic SDK — `claude-haiku-4-5` for reply classification and signed-PDF validation. |
| Orchestration | Docker Compose (project name `crm`), services `server` + `web`. |
| Persistence | **Flat JSON files** (no DB) under `server/data/`, all git-ignored + bind-mounted so they survive rebuilds. |

```
/
├── server/            # Node backend (index.js); data/ + sessions/ are git-ignored, bind-mounted
│   └── data/          # leads.json, config.json, documents/, signed/   (persistent, NOT in git)
├── web/               # Next.js app (web/AGENTS.md has the mobile-first UI rules)
├── docker-compose.yml
├── ecosystem.config.cjs / start.sh
└── CLAUDE.md
```

## Common Commands

```bash
# Backend (server/)
cd server && npm install
npm run dev        # node --watch index.js
npm start          # node index.js  (listens on :10001)

# Web (web/)
cd web && npm install
npm run dev        # next dev → http://localhost:3000
npm run build && npm start

# Docker (whole stack)
docker compose up -d --build
docker compose logs -f server      # tail the WhatsApp/Telegram backend
```
There is **no test suite** in this repo yet.

## Core Domain Model — read before touching CRM logic

- **`status` is the single source of truth** per lead (16 statuses, defined in `web/app/components/status.ts` and `STATUSES` in `server/index.js`): outreach (`new`,`contacted`) · triage (`question`,`review`) · pipeline (`interested → invited → confirmed → scheduled → attended → agreement → signed → onboarding → booked → onboarded`) · closed (`declined`,`opted_out`). **Each view is a filter over `status`; a lead appears in exactly one place.**
- **Manual-send mode.** The inbound handler classifies replies and *advances status* but **NEVER auto-sends** messages (WhatsApp delivery is ban-prone). Reps send from their own phones, then mark status in the UI. The one exception that runs automatically is read-only: validating a returned signed agreement (below).
- **Baileys-free WhatsApp outbound (click-to-chat).** Baileys (WhatsApp Web reverse-engineering) is ban/IP-fragile — it took a hard `428` block from the datacenter IP and couldn't be reliably tunnelled — so **outbound WhatsApp no longer goes through a socket.** Every WhatsApp "Send" is now an **"Open in WhatsApp"** button (Inbox/Pipeline/Directory): the UI opens a `https://wa.me/<phone>?text=<editable AI suggestion>` deep link so the rep sends from *their own* WhatsApp app, then the CRM **records** it via `POST /api/leads/:id/log-sent` (appends to the thread + bumps last-contacted; a `new` lead → `contacted`). The server transmits nothing. **Inbound has two paths:** (a) a rep manually logs an incoming reply via `POST /api/leads/:id/reply`; (b) the **on-prem read-only receiver** (`onprem-receiver/`) — a passive Baileys listener on the residential box (where Baileys connects) that POSTs incoming messages *and* the rep's own `fromMe` sends to **`POST /api/ingest`** (token-authed via `INGEST_TOKEN`, reached through the public `/api/proxy/ingest` allowlisted in `web/proxy.ts`). Both paths feed the **shared `advanceLeadFromInbound()` pipeline** (also used by the now-dormant live socket handler): opt-out · decline-at-any-stage · classify pre-pipeline · attendance for `invited` · signed-PDF validation for `agreement` · `classifyStage` forward-move otherwise. The intelligence only needs the *text/file*, not an outbound socket. The receiver never sends (no ban risk) and holds no CRM data/secrets. **Telegram stays fully automated** (ban-free, `tgSend`). The Baileys *sending* machinery (multi-number sockets/caps/warming/shadow-ban monitor) stays in the code but dormant behind `WA_DISABLED`.
- **Multi-number WhatsApp.** Up to 10 Baileys sockets, one session dir each under `server/sessions/<id>/`. Leads are **sticky-assigned** to a number (`lead.assignedNumber`). Guardrails: per-number daily caps, warming ramp, quiet hours (07:00–22:30 SGT), opt-out detection, delivery-receipt monitoring (shadow-ban detection) + 6h recovery probe. Telegram (`@Petsafter_bot`) is a ban-free parallel channel running the same pipeline.
- **Representative name per number.** Each WhatsApp number carries an editable `repName` (`config.numbers[].repName`, set in the Numbers panel). `repNameFor(lead)` resolves it from `lead.assignedNumber` and it's auto-woven into outbound copy (AI suggested replies, the outreach opener's `[RepIntro]`, and the agreement caption) so leads are told who's messaging them. Empty `repName` degrades to no-name. Current: Number 1 → Vince/Sam, Number 2 → Vivian, Number 3 → Vicky.
- **Agreement flow — e-sign portal (primary).** Structured milestones live on **owned links**, not chat. `POST /api/wf/agreement/:id` marks the lead `agreement` and records a caption that carries the lead's **e-sign link** (`signUrl(id)` → `/sign/<HMAC token>`, namespaced `sign:` so booking tokens can't be swapped in; public paths allowlisted in `web/proxy.ts`). The lead opens the portal (`web/app/sign/[token]/page.tsx`, mobile-first): reads the agreement (`GET /api/sign/:token/doc`), fills `config.json → requiredFields` as **form inputs** (signature-named fields become a draw-canvas), submits → the server validates **deterministically** (`POST /api/sign/:token` rejects with the `missing` list), stamps a signature-certificate page onto the agreement PDF (pdf-lib; timestamp + IP audit line), stores it **encrypted** in `SIGNED_DIR`, sets `wf.signed` (`method:'esign'`, always `complete`) and advances to `signed`. The Pipeline card offers **Open WhatsApp** (caption with sign link), **Copy sign link**, and a **PDF** fallback (`GET /api/documents/:id/download`). The legacy path still works: a returned **PDF over chat** (Telegram/ingest) is Claude-validated against `requiredFields` and only advances when complete.

## Critical Rules

- **Atomic leads.json writes.** No DB/locking. Any write to `leads.json` that follows an `await` MUST go through `mutateLeads(fn)` (reads fresh + sync-mutates + saves, no await in between). Never `read → await → saveLeads` — concurrent inbound replies get silently lost. Do all slow work (AI, media, sendMessage) *before* `mutateLeads`.
- **Minimise `crm-server` rebuilds.** Every server restart reconnects WhatsApp and churns E2E sessions (can cause "Waiting for this message" undelivered bubbles — mitigated by the Baileys `getMessage` handler). Batch server changes into one deploy.
- **Mobile-first UI.** All web UI must be responsive to 375px, mobile-first. See `web/AGENTS.md`.
- **Secrets are server-side only.** `.env` is git-ignored and never pushed (AUTH_*, ANTHROPIC_API_KEY, TELEGRAM_TOKEN live in the production `.env`). Changing env-handling code requires updating the server `.env` AND recreating the affected container — git push alone won't set env.

## Deployment

Production runs as Docker Compose project `crm` on a single droplet. A **cron auto-deploy** polls `origin/main` every minute and rebuilds **only the changed service**: `web/*` → web only, `server/*` → server only (drops the WhatsApp link briefly), `*.md`/docs → no rebuild, root/compose → both. Persistent data (`leads.json`, `config.json`, `sessions/`, `.env`) is git-ignored and survives `git reset --hard`. **To ship: commit to `main` and push** — there is no PR gate. The 1-vCPU box builds slowly (~4–5 min, serialized under a flock), so batch changes.

## Testing & CI

Tests live in three layers; **green CI is the merge gate** for `main` (CI is advisory vs the cron deploy, which can't be blocked server-side — so don't merge a red PR).

- **Server unit + integration** — Node built-in `node:test` (zero deps), under `server/test/`. `index.js` is import-safe under `NODE_ENV=test` (a `BOOT` guard skips WhatsApp/Telegram/the listener and the background timers) and its data dir is overridable via `WATAPP_DATA_DIR`. Integration tests boot the real Express `app` on an ephemeral port with **fake open sockets injected into `conns`** so sends are captured, not transmitted (see `server/test/helpers/harness.js`). The agreement test guards the `firstSock` regression; `concurrency.test.js` guards the `mutateLeads` atomic-write rule.
  - Run: `cd server && NODE_ENV=test node --test test/unit/*.test.js test/integration/*.test.js`
- **E2E** — Playwright (full UI) in top-level `e2e/` (own `package.json`, keeps Playwright out of prod deps). `e2e/test-server.mjs` boots the server in test mode against a temp copy of `e2e/fixtures/` with fake sockets; Playwright also runs the built web (`next start`) with test `AUTH_*` creds + `WA_SERVER_URL`.
  - Run: `cd e2e && npm run test:full` (builds web, boots both servers, runs specs headless).
- **CI** — `.github/workflows/ci.yml`, jobs `server` / `web-build` / `e2e` on `node:20`, triggered on PRs and pushes to `main`.

When changing server logic, keep `index.js` import-safe (no new unguarded top-level side-effects/timers) and add/adjust a test.

## Recent Work & Learnings (2026-06-26)

- **Agreement now sends from the lead's own number.** `sendDocumentsTo()` was hardcoded to `firstSock()` (always Number 1), so agreements went out from the wrong number and broke each rep's existing thread. Fixed (`4c1f71d`): it takes an optional socket and `/api/wf/agreement/:id` passes `sockForLead(lead)`; it now also sets canonical `status='agreement'` and records the real caption in `sentReplies`.
- **Deploy script hardened:** docs-only (`*.md`) changes no longer trigger a rebuild, so updating this file (or other docs) won't churn the WhatsApp connection.
- Sent the associate agreement to 5 brief attendees (Gabrielle Ho · Yumi · Desmond Low · Bezalel Tan Tiong Ghee · Heng Lee Peng), each from its rep's number; all held at `agreement`. Now waiting on signed-PDF returns, which the bot auto-validates as described above.
