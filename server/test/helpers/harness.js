// Integration-test harness: boots the real Express app from server/index.js in
// test mode (no WhatsApp/Telegram/listener side-effects), pointed at an isolated
// temp data dir, with FAKE WhatsApp sockets injected so sends are captured.
//
// IMPORTANT: env (NODE_ENV, WATAPP_DATA_DIR) is set BEFORE the dynamic import,
// because index.js reads those at module-load. node --test runs each test file in
// its own process, so the module singleton (and its data dir) is per-file.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Minimal valid-ish PDF bytes; the agreement endpoint only readFileSync's it.
const STUB_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export async function bootTestServer({ leads = [], config = {}, documents = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watapp-it-'));
  mkdirSync(join(dir, 'documents'), { recursive: true });
  mkdirSync(join(dir, 'signed'), { recursive: true });

  const seedLeads = (ls) => writeFileSync(join(dir, 'leads.json'), JSON.stringify(ls, null, 2));
  seedLeads(leads);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'documents.json'), JSON.stringify(documents, null, 2));
  for (const d of documents) writeFileSync(join(dir, 'documents', d.file), STUB_PDF);

  process.env.NODE_ENV = 'test';
  process.env.WATAPP_DATA_DIR = dir;
  delete process.env.ANTHROPIC_API_KEY; // force keyword classify fallback — no network
  delete process.env.TELEGRAM_TOKEN;

  const mod = await import('../../index.js');
  const { app, conns } = mod;

  const records = []; // every fake sock send: { numId, jid, msg }
  const addNumber = (numId, phone) => conns.set(numId, {
    state: 'open', phone, paused: false, health: 'ok',
    sock: { sendMessage: async (jid, msg) => { records.push({ numId, jid, msg }); return { key: { id: 'mid-' + (records.length) } }; } },
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base, conns, records, mod, dir, addNumber, seedLeads,
    async close() { try { server.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// Tiny fetch wrapper: JSON in/out.
export const api = (base, path, opts = {}) => fetch(base + path, {
  method: opts.method || 'GET',
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
});
