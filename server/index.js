import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
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
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      connectionState = 'close';
      currentQR = null;
      console.log('[WA] Disconnected, code:', code);
      if (shouldReconnect) {
        console.log('[WA] Reconnecting…');
        setTimeout(connectWA, 3000);
      }
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

  for (const id of ids) {
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
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
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
