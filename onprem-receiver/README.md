# On-prem WhatsApp receiver (read-only)

Closes the one gap of the Baileys-free CRM: **inbound sync**. Outbound is click-to-chat
deep links (reps send from their own app, zero ban risk). This listener syncs the
**incoming** side back into the CRM automatically.

## Why it exists / why it's safe
WhatsApp `428`-blocks Baileys from the CRM's **datacenter** IP, but connects fine from a
**residential** IP. So this tiny service runs on the on-prem (residential) box, links as a
**read-only device** (like WhatsApp Web), and forwards messages to the CRM's `/api/ingest`.

- It **never sends** a WhatsApp message → carries no send-ban risk (sending is what gets
  numbers banned; passive listening is what WhatsApp Web does all day).
- It holds **no CRM data or secrets** — only the WhatsApp session + the CRM URL + a shared
  `INGEST_TOKEN`.
- It syncs **both directions**: incoming replies *and* the rep's own deep-link sends
  (`fromMe`), so the CRM thread stays complete. The CRM then classifies + advances the
  pipeline exactly as before (including signed-agreement PDF validation).

## Setup (on the on-prem box, once)
1. Set a shared secret on the **CRM server** — add `INGEST_TOKEN=<long-random>` to
   `/root/CRM/.env` on the droplet and recreate the server container:
   `docker compose up -d --force-recreate server`
2. On the on-prem box:
   ```bash
   cd onprem-receiver
   cp .env.example .env      # set INGEST_TOKEN (same value) + NUMBER_ID
   docker compose up -d --build
   docker compose logs -f    # a QR appears
   ```
3. On the phone for that number: **WhatsApp → Settings → Linked Devices → Link a device**,
   scan the QR. The log prints `✓ linked & listening`. The link persists in `./session/`.

Run one receiver per number (separate folders/`NUMBER_ID`s, or extend the compose file).

## Config (`.env`)
| Var | Meaning |
|-----|---------|
| `INGEST_TOKEN` | **Must match** the CRM server's `INGEST_TOKEN`. |
| `CRM_INGEST_URL` | Default `https://crm.urbanwerkzsg.com/api/proxy/ingest`. |
| `NUMBER_ID` | CRM number id this line maps to (sticky assignment + thread label), e.g. `onprem-n2`. |

## Operating notes
- Keep the box online; the container `restart: unless-stopped` + auto-reconnects (gently).
- If a number gets logged out, delete its `session/` and re-link.
- Bring numbers back **slowly** and keep volume low — the numbers were recently restricted.
- To stop syncing a number: `docker compose down` (outbound deep links keep working regardless).
