// Boots the REAL backend (server/index.js) in test mode against an isolated,
// throwaway data dir, with WhatsApp FAKED: we inject fake OPEN sockets into the
// exported `conns` map so `sock.sendMessage` is captured in-memory instead of
// being transmitted. Because NODE_ENV=test, index.js does NOT auto-connect
// WhatsApp/Telegram nor start its own HTTP listener — we listen here ourselves.

import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1) Copy the seed fixtures to a fresh temp dir so every boot is clean + isolated.
const dataDir = mkdtempSync(join(tmpdir(), 'watapp-e2e-'));
cpSync(join(__dirname, 'fixtures'), dataDir, { recursive: true });

// 2) Test environment: no real WhatsApp/Telegram/AI, isolated data dir.
process.env.NODE_ENV = 'test';
process.env.WATAPP_DATA_DIR = dataDir;
delete process.env.ANTHROPIC_API_KEY; // force keyword-fallback classification (no network)
delete process.env.TELEGRAM_TOKEN;    // don't start the Telegram long-poll

// 3) Import the real server module (exports app + conns; does not boot under test).
const { app, conns } = await import('../server/index.js');

// 4) Inject fake OPEN sockets for the three configured numbers. sendMessage just
//    records the outbound message and returns a Baileys-shaped ack { key: { id } }.
const captured = [];
let seq = 0;
function fakeSock(numId) {
  return {
    user: { id: `${numId}-fake:0@s.whatsapp.net` },
    async sendMessage(jid, content) {
      const id = `FAKE_${numId}_${++seq}`;
      captured.push({ numId, jid, content, id, at: Date.now() });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    async logout() {},
    updateMediaMessage: async (m) => m,
  };
}
for (const [numId, phone] of [['n1', '6511110001'], ['n2', '6511110002'], ['n3', '6511110003']]) {
  conns.set(numId, {
    sock: fakeSock(numId),
    state: 'open',
    label: { n1: 'Number 1', n2: 'Number 2', n3: 'Number 3' }[numId],
    phone,
    health: 'ok',
    reconnects: 0,
    qr: null,
  });
}

// 5) Listen ourselves (index.js skips app.listen under NODE_ENV=test).
const PORT = Number(process.env.PORT) || 10001;
app.listen(PORT, () => {
  console.log(`[e2e test-server] listening on http://localhost:${PORT}  data=${dataDir}`);
});
