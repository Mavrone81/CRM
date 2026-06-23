import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { rmSync, readdirSync } from 'fs';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = join(__dirname, 'data', 'leads.json');

// ── State ─────────────────────────────────────────────────────────────────────
let sock = null;
let connectionState = 'close'; // 'close' | 'connecting' | 'open'
let currentQR = null;           // base64 QR image

// ── Helpers ───────────────────────────────────────────────────────────────────
function readLeads() {
  return JSON.parse(readFileSync(LEADS_PATH, 'utf8'));
}

function saveLeads(leads) {
  writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2));
}

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // 8-digit SG local number
  if (digits.length === 8) return `65${digits}`;
  // already has country code
  return digits;
}

function toJid(phone) {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;
  return `${normalised}@s.whatsapp.net`;
}

function buildMessage(name) {
  return `Hi ${name}, We connected previously regarding a business/career opportunity, but I recently switched to WhatsApp Business and lost my chat history.\n\nI'm updating my records and wanted to check if you're still open to hearing about opportunities or additional income streams.\n\nIf yes, just reply "Interested" and I'll send you the details. If not, no worries and I won't follow up further.`;
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState(
    join(__dirname, 'sessions')
  );
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Watapp', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  // Track incoming replies
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const senderJid = msg.key.remoteJid || '';
      const senderPhone = senderJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '[media]';

      const leads = readLeads();
      const lead = leads.find((l) => normalisePhone(l.phone) === senderPhone);
      if (!lead) continue;

      if (!lead.replies) lead.replies = [];
      lead.replies.push({ text, timestamp: new Date().toISOString() });
      saveLeads(leads);
      console.log(`[reply] ${lead.name}: ${text}`);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      connectionState = 'connecting';
      console.log('[WA] QR generated — scan in dashboard');
    }

    if (connection === 'open') {
      connectionState = 'open';
      currentQR = null;
      console.log('[WA] Connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      connectionState = 'close';
      currentQR = null;
      console.log('[WA] Disconnected, code:', code);

      if (code === DisconnectReason.loggedOut) {
        // Account logged out or banned — clear session so a new account can be linked
        console.log('[WA] Session ended (logged out / restricted) — clearing session for fresh QR');
        try {
          const files = readdirSync(join(__dirname, 'sessions'));
          for (const f of files) rmSync(join(__dirname, 'sessions', f), { recursive: true, force: true });
        } catch {}
      }

      // Always reconnect — will generate a fresh QR if session was cleared
      console.log('[WA] Reconnecting in 3s…');
      setTimeout(connectWA, 3000);
    }
  });
}

connectWA();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Status + QR
app.get('/api/status', (_req, res) => {
  res.json({ state: connectionState, qr: currentQR });
});

// All leads
app.get('/api/leads', (_req, res) => {
  res.json(readLeads());
});

// Add new lead
app.post('/api/leads', (req, res) => {
  const { name, phone, email, notes, adviser } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  const leads = readLeads();
  const id = leads.length ? Math.max(...leads.map((l) => l.id)) + 1 : 1;
  const lead = { id, name, phone, email: email || '', notes: notes || '', adviser: adviser || '', created: new Date().toISOString(), sent: false, sentAt: null, replies: [] };
  leads.unshift(lead);
  saveLeads(leads);
  res.status(201).json(lead);
});

// Mark lead sent/unsent
app.patch('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  Object.assign(lead, req.body);
  saveLeads(leads);
  res.json(lead);
});

// Bulk send — must be registered BEFORE /api/send/:id to avoid route shadowing
const BATCH_SIZE = 40;
const BATCH_PAUSE = 30000; // 30s between batches

app.post('/api/send/bulk', async (req, res) => {
  if (connectionState !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  const { ids, message: customMessage } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'provide ids array' });
  }

  const leads = readLeads();
  const results = [];

  // Split into chunks of 40
  const chunks = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    chunks.push(ids.slice(i, i + BATCH_SIZE));
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];

    for (const id of chunk) {
      const lead = leads.find((l) => l.id === id);
      if (!lead) { results.push({ id, ok: false, error: 'not found' }); continue; }

      const jid = toJid(lead.phone);
      if (!jid) { results.push({ id, ok: false, error: 'invalid phone' }); continue; }

      const message = customMessage || buildMessage(lead.name);

      try {
        await sock.sendMessage(jid, { text: message });
        lead.sent = true;
        lead.sentAt = new Date().toISOString();
        results.push({ id, ok: true });
        // Random 8–15s delay between messages to mimic human behaviour
        const delay = 8000 + Math.floor(Math.random() * 7000);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }

    // 30s pause between batches (skip after last batch)
    if (c < chunks.length - 1) {
      console.log(`[bulk] Batch ${c + 1}/${chunks.length} done — pausing 30s`);
      await new Promise((r) => setTimeout(r, BATCH_PAUSE));
    }
  }

  saveLeads(leads);
  res.json({ results });
});

// Send to one lead
app.post('/api/send/:id', async (req, res) => {
  if (connectionState !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });

  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });

  const message = req.body.message || buildMessage(lead.name);

  try {
    await sock.sendMessage(jid, { text: message });
    lead.sent = true;
    lead.sentAt = new Date().toISOString();
    saveLeads(leads);
    res.json({ ok: true, lead });
  } catch (err) {
    console.error('[send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Logout (delete session)
app.post('/api/logout', async (_req, res) => {
  if (sock) {
    await sock.logout().catch(() => {});
    sock = null;
  }
  connectionState = 'close';
  currentQR = null;
  res.json({ ok: true });
});

const PORT = process.env.PORT || 10001;
app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
