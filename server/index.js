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
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = join(__dirname, 'data', 'leads.json');

// ── AI classifier (Claude) ─────────────────────────────────────────────────────
// Falls back to keyword matching when ANTHROPIC_API_KEY is not set.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = 'claude-haiku-4-5';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['interested', 'not_interested', 'question', 'other'],
      description: 'How the contact responded to the outreach message',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident you are in the category',
    },
    reason: {
      type: 'string',
      description: 'One short sentence explaining the classification',
    },
    suggested_reply: {
      type: 'string',
      description: 'A short, friendly reply to send back to this contact',
    },
  },
  required: ['category', 'confidence', 'reason', 'suggested_reply'],
  additionalProperties: false,
};

// Keyword fallback when no API key is configured
function classifyKeyword(text) {
  const t = (text || '').toLowerCase();
  if (/\b(not interested|no thanks|no thank|stop|unsubscribe|remove me|leave me)\b/.test(t) || /^\s*no\s*$/.test(t))
    return { category: 'not_interested', confidence: 'low', reason: 'Keyword match (no API key set)', suggested_reply: 'No worries at all — thanks for letting me know. Take care!' };
  if (/\b(interested|yes|yep|yeah|sure|ok|okay|keen|tell me|more info|details)\b/.test(t))
    return { category: 'interested', confidence: 'low', reason: 'Keyword match (no API key set)', suggested_reply: 'Great! I\'ll send over the details shortly.' };
  if (/\?/.test(t))
    return { category: 'question', confidence: 'low', reason: 'Contains a question mark', suggested_reply: 'Good question — happy to explain. Let me get you the details.' };
  return { category: 'other', confidence: 'low', reason: 'No keyword match (no API key set)', suggested_reply: '' };
}

async function classifyReplies(name, replies) {
  const transcript = replies.map((r) => `- ${r.text}`).join('\n');
  if (!anthropic) return classifyKeyword(replies[replies.length - 1]?.text || '');

  const prompt = `You are triaging WhatsApp replies for a recruitment/business-opportunity outreach campaign. We sent this contact a message asking if they're open to hearing about opportunities or extra income, and to reply "Interested" if so.

Contact name: ${name}
Their reply/replies:
${transcript}

Classify their response and draft a short, warm reply we could send back. Be concise.`;

  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error('[ai] classify failed, falling back:', err.message);
    return classifyKeyword(replies[replies.length - 1]?.text || '');
  }
}

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
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      // WhatsApp Business / privacy routes senders via @lid identifiers, not
      // phone@s.whatsapp.net. Collect every JID the message exposes and pull
      // the real phone number from whichever one carries it.
      const jids = [
        msg.key.remoteJid,
        msg.key.remoteJidAlt,   // PN counterpart of an @lid chat (newer Baileys)
        msg.key.participant,
        msg.key.participantAlt,
        msg.key.senderPn,
      ].filter(Boolean);
      const phoneJid = jids.find((j) => j.includes('@s.whatsapp.net'));
      const senderPhone = (phoneJid || '').replace('@s.whatsapp.net', '');
      const senderDigits = senderPhone.replace(/\D/g, '');

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '[media]';

      const leads = readLeads();
      // Match on full normalised number, with a last-8-digits fallback so a
      // missing/extra country code still resolves to the right lead.
      const lead = leads.find((l) => {
        const norm = normalisePhone(l.phone) || '';
        if (senderPhone && norm === senderPhone) return true;
        const leadDigits = (l.phone || '').replace(/\D/g, '');
        return senderDigits.length >= 8 && leadDigits.length >= 8 &&
          senderDigits.slice(-8) === leadDigits.slice(-8);
      });
      if (!lead) {
        console.log(`[reply] unmatched incoming — jids=${JSON.stringify(jids)} text="${text.slice(0, 40)}"`);
        continue;
      }

      if (!lead.replies) lead.replies = [];
      lead.replies.push({ text, timestamp: new Date().toISOString() });
      saveLeads(leads);
      console.log(`[reply] ${lead.name}: ${text}`);

      // Classify with AI (re-read + save to avoid stomping concurrent writes)
      const ai = await classifyReplies(lead.name, lead.replies);
      const fresh = readLeads();
      const target = fresh.find((l) => l.id === lead.id);
      if (target) {
        target.ai = { ...ai, classifiedAt: new Date().toISOString() };
        saveLeads(fresh);
        console.log(`[ai] ${lead.name}: ${ai.category} (${ai.confidence})`);
      }
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
  res.json({ state: connectionState, qr: currentQR, ai: !!anthropic });
});

// Classify all leads with replies that haven't been classified yet
// (registered BEFORE /api/classify/:id so "all" isn't matched as an id)
app.post('/api/classify/all', async (_req, res) => {
  const leads = readLeads();
  const pending = leads.filter((l) => l.replies?.length && !l.ai);
  let done = 0;
  for (const lead of pending) {
    const ai = await classifyReplies(lead.name, lead.replies);
    const fresh = readLeads();
    const target = fresh.find((l) => l.id === lead.id);
    target.ai = { ...ai, classifiedAt: new Date().toISOString() };
    saveLeads(fresh);
    done++;
  }
  res.json({ ok: true, classified: done });
});

// Send a free-text reply to a lead (e.g. the AI-suggested reply).
// Does NOT touch the outreach `sent` flag — this is a follow-up message.
app.post('/api/reply/:id', async (req, res) => {
  if (connectionState !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });

  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });

  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });

  try {
    await sock.sendMessage(jid, { text: message });
    if (!lead.sentReplies) lead.sentReplies = [];
    lead.sentReplies.push({ text: message, timestamp: new Date().toISOString() });
    saveLeads(leads);
    console.log(`[reply-sent] ${lead.name}: ${message.slice(0, 50)}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[reply-sent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Re-classify one lead's replies on demand
app.post('/api/classify/:id', async (req, res) => {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (!lead.replies?.length) return res.status(400).json({ error: 'no replies to classify' });

  const ai = await classifyReplies(lead.name, lead.replies);
  const fresh = readLeads();
  const target = fresh.find((l) => l.id === lead.id);
  target.ai = { ...ai, classifiedAt: new Date().toISOString() };
  saveLeads(fresh);
  res.json({ ok: true, ai: target.ai });
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
