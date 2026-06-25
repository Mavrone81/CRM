import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys';
import { rmSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'fs';
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
const CONFIG_PATH = join(__dirname, 'data', 'config.json');
const KNOWLEDGE_PATH = join(__dirname, 'knowledge.md');
const DOCS_DIR = join(__dirname, 'data', 'documents');
const DOCS_META_PATH = join(__dirname, 'data', 'documents.json');
const SIGNED_DIR = join(__dirname, 'data', 'signed'); // returned signed agreements
if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
if (!existsSync(SIGNED_DIR)) mkdirSync(SIGNED_DIR, { recursive: true });

// ── Recruitment pipeline stages (ordered) ───────────────────────────────────────
// A lead with no `stage` lives only in the Leads/Replies inbox. When the interest
// classifier tags it "interested" it is auto-surfaced into the first stage, 'brief'.
// After 'agreement_sent', the bot auto-validates the returned signed PDF, then
// auto-advances to onboarding (role: Lead -> Potential On-board -> On-board).
const STAGES = ['brief', 'confirmed', 'slotted', 'attended', 'agreement_sent', 'onboarding', 'onboarding_slotted', 'onboarded'];

// ── Canonical lead lifecycle: a single `status` field is the source of truth ─────
const STATUSES = [
  'new', 'contacted', 'question', 'review',
  'interested', 'invited', 'confirmed', 'scheduled', 'attended',
  'agreement', 'signed', 'onboarding', 'booked', 'onboarded',
  'declined', 'opted_out',
];
const PIPELINE_STATUSES = ['interested', 'invited', 'confirmed', 'scheduled', 'attended', 'agreement', 'signed', 'onboarding', 'booked', 'onboarded'];

// Derive a lead's status from the legacy fields (one-time migration + new-lead default).
function deriveStatus(l) {
  const stage = l.stage, ai = l.ai && l.ai.category, wf = l.wf || {};
  const sent = (kind) => (l.sentReplies || []).some((r) => r.kind === kind);
  if (stage === 'onboarded') return 'onboarded';
  if (stage === 'onboarding_slotted') return 'booked';
  if (stage === 'onboarding') return 'onboarding';
  if (stage === 'agreement_sent') return (wf.signed && wf.signed.result && wf.signed.result.complete) ? 'signed' : (sent('agreement') ? 'agreement' : 'attended');
  if (stage === 'attended') return 'attended';
  if (stage === 'slotted') return 'scheduled';
  if (stage === 'confirmed') return 'confirmed';
  if (stage === 'brief') return sent('brief-invite') ? 'invited' : 'interested';
  if (stage === 'declined') return wf.optedOut ? 'opted_out' : 'declined';
  if (wf.optedOut) return 'opted_out';
  if (ai === 'interested') return 'interested';
  if (ai === 'not_interested') return 'declined';
  if (ai === 'question') return 'question';
  if (ai === 'other') return 'review';
  if ((l.replies || []).length) return 'review';
  if (l.sent) return 'contacted';
  return 'new';
}

// Map an AI reply category to a triage status (used when a NEW reply arrives).
function statusFromCategory(cat) {
  return cat === 'interested' ? 'interested' : cat === 'not_interested' ? 'declined' : cat === 'question' ? 'question' : 'review';
}

// One-time idempotent migration: backfill `status` on any lead missing it.
function ensureStatuses() {
  let leads;
  try { leads = readLeads(); } catch { return; }
  const missing = leads.filter((l) => !l.status);
  if (!missing.length) return;
  try { writeFileSync(LEADS_PATH + `.bak.${Date.now()}`, JSON.stringify(leads, null, 2)); } catch {}
  for (const l of leads) if (!l.status) l.status = deriveStatus(l);
  saveLeads(leads);
  console.log(`[migrate] backfilled status on ${missing.length} lead(s)`);
}

// ── Knowledge base ──────────────────────────────────────────────────────────────
// Loaded ONCE at startup (baked into the bot — never re-parsed per message).
let KNOWLEDGE = '';
try {
  KNOWLEDGE = readFileSync(KNOWLEDGE_PATH, 'utf8');
  console.log(`[kb] loaded knowledge base (${KNOWLEDGE.length} chars)`);
} catch {
  console.log('[kb] no knowledge.md found — replies will be generic');
}

// ── Config (auto-reply mode, sessions, brief template) ──────────────────────────
const CONFIG_DEFAULTS = {
  autoReply: false,
  // Briefing sessions an attendee can be slotted into (editable from the UI).
  sessions: [
    { id: 'thu', label: 'Thursday 7:30pm', date: '', capacity: 10 },
    { id: 'sun', label: 'Sunday 2:00pm', date: '', capacity: 10 },
  ],
  // Default personalised invite for the Brief stage. [Name] -> lead's name,
  // [Sessions] -> the formatted list of sessions (with dates) at compose time.
  briefTemplate:
    "Hi [Name], great to hear you're keen! We'd love to have you at our recruitment briefing.\n\nUpcoming sessions:\n[Sessions]\n\nWhich timing suits you best? Once you confirm I'll reserve your spot.",

  // ── Phase 2: onboarding (2nd) sessions, signed-agreement validation, templates ──
  onboardingSessions: [
    { id: 'ob1', label: 'Onboarding — Mon 7:00pm', date: '', capacity: 10 },
    { id: 'ob2', label: 'Onboarding — Sat 10:00am', date: '', capacity: 10 },
  ],
  // Fields the signed agreement MUST contain to be considered complete.
  requiredFields: [
    'Full name (as in NRIC)', 'NRIC number', 'Nationality', 'Date of birth',
    'Gender', 'Marital status', 'Home address', 'Mobile number',
    'Commencement date', "Associate's signature",
  ],
  // Auto-reply when the returned signed agreement is missing fields. [Missing] -> bullet list.
  chaseTemplate:
    "Thanks [Name]! I had a look at your signed agreement, but a few details still need completing:\n[Missing]\n\nPlease fill those in and send the signed PDF back to me here.",
  // Auto-reply when the agreement is complete + signed. [Sessions] -> onboarding options.
  onboardingTemplate:
    "Thank you [Name] — your agreement is complete and received! 🎉 Welcome aboard.\n\nNext is your onboarding session. Please pick one:\n[Sessions]\n\nReply with the one that works for you and I'll lock it in.",
};
function readConfig() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return { ...CONFIG_DEFAULTS, ...saved };
}
function writeConfig(cfg) { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

// ── Documents (uploadable agreements etc.) ───────────────────────────────────────
function readDocs() {
  try { return JSON.parse(readFileSync(DOCS_META_PATH, 'utf8')); } catch { return []; }
}
function saveDocs(docs) { writeFileSync(DOCS_META_PATH, JSON.stringify(docs, null, 2)); }

// ── AI classifier (Claude) ─────────────────────────────────────────────────────
// Falls back to keyword matching when ANTHROPIC_API_KEY is not set.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = 'claude-haiku-4-5';

// Random style nudges so AI-drafted replies vary per lead (anti-repetition).
const STYLE_HINTS = [
  'open casually, like you are continuing a chat',
  'lead with a little genuine warmth in your own words',
  'keep it brief and easy-going',
  'sound personable and a touch curious about them',
  'be relaxed and friendly, low-pressure',
  'acknowledge what they said first, then steer gently',
];

// Spintax: {a|b|c} picks one variant at random -> every outbound message differs.
function spin(text) {
  if (!text) return text;
  let out = text, guard = 0;
  while (out.includes('{') && guard++ < 50) {
    out = out.replace(/\{([^{}]*)\}/, (_, group) => {
      const opts = group.split('|');
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return out;
}

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

  const system = `You are the WhatsApp assistant for a Pet Afterlife SG recruitment outreach. We message contacts asking if they're open to a flexible-income opportunity and to reply "Interested".

Your job: classify each contact's reply, and draft a SHORT reply we can send back — grounded ONLY in the knowledge base below. Never invent prices, commission rates, dates, or commitments. If they're interested or asking to learn more, invite them to a briefing session (Thursday 7:30pm or Sunday 2pm) and ask which suits them.

VOICE — write the reply like a REAL person texting, never a template:
- Vary your wording EVERY time. Never reuse stock openers ("Great!", "Awesome!") or the same sentence structures. Two replies to two different people must never read alike.
- Sound natural, warm and human — like a friendly colleague texting, not a corporate script. Light and conversational.
- Keep it short for WhatsApp (1-3 sentences). Match their energy. Never pushy.

=== KNOWLEDGE BASE ===
${KNOWLEDGE}
=== END KNOWLEDGE BASE ===`;

  const hint = STYLE_HINTS[Math.floor(Math.random() * STYLE_HINTS.length)];
  const prompt = `Contact name: ${name}
Their reply/replies:
${transcript}

Classify their response and draft the reply to send back. For the reply: ${hint}. Make it feel individually written — fresh phrasing, no reused lines (variation seed: ${Math.random().toString(36).slice(2, 8)}).`;

  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      temperature: 1, // high variety so replies don't repeat across leads
      // Cache the system+knowledge prefix so it isn't re-billed every message
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
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

// ── Attendance classifier ───────────────────────────────────────────────────────
// Runs on replies AFTER a brief invite has been sent. Decides whether the contact
// confirmed they'll attend the briefing, declined, or it's still unclear.
const ATTEND_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['confirmed', 'declined', 'unclear'], description: 'Whether they confirmed attendance at the briefing' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One short sentence explaining the decision, noting any session/timing preference they mentioned' },
  },
  required: ['status', 'confidence', 'reason'],
  additionalProperties: false,
};

function attendKeyword(text) {
  const t = (text || '').toLowerCase();
  if (/\b(can'?t|cannot|can not|not able|unable|busy|not interested|maybe not|reschedule|another time|next time)\b/.test(t) || /^\s*no\b/.test(t))
    return { status: 'declined', confidence: 'low', reason: 'Keyword match (no API key set)' };
  if (/\b(yes|yep|yeah|confirm|confirmed|coming|i'?m in|attend|see you|sure|ok|okay|thursday|sunday|thu|sun)\b/.test(t))
    return { status: 'confirmed', confidence: 'low', reason: 'Keyword match (no API key set)' };
  return { status: 'unclear', confidence: 'low', reason: 'No clear confirmation keyword (no API key set)' };
}

async function classifyAttendance(name, replies) {
  const last = replies[replies.length - 1]?.text || '';
  if (!anthropic) return attendKeyword(last);

  const transcript = replies.map((r) => `- ${r.text}`).join('\n');
  const system = `You manage attendance for a recruitment briefing. Invited contacts were asked to confirm whether they'll attend a session (Thursday 7:30pm or Sunday 2pm). Read the contact's replies and decide if they have CONFIRMED they'll attend, DECLINED, or it's still UNCLEAR. Note any session/timing preference in your reason.`;
  const prompt = `Contact name: ${name}
Their replies (most recent last):
${transcript}

Classify their attendance.`;

  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 256,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: ATTEND_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error('[ai] attendance classify failed, falling back:', err.message);
    return attendKeyword(last);
  }
}

// ── Session list formatting (for the auto onboarding offer) ──────────────────────
function fmtSessionList(sessions) {
  return (sessions || []).map((s) => `• ${s.label}${s.date ? ` · ${s.date}` : ''}`).join('\n');
}

// ── Signed-agreement validator (Claude reads the PDF) ────────────────────────────
const SIGNED_SCHEMA = {
  type: 'object',
  properties: {
    signed: { type: 'boolean', description: "Whether the Associate's handwritten signature is present on the signature page" },
    missing: { type: 'array', items: { type: 'string' }, description: 'Required fields that are blank, missing or illegible' },
    complete: { type: 'boolean', description: 'True ONLY if signed is true AND missing is empty' },
    notes: { type: 'string', description: 'One short sentence on what was checked' },
  },
  required: ['signed', 'missing', 'complete', 'notes'],
  additionalProperties: false,
};

async function validateSignedAgreement(name, pdfBase64, requiredFields) {
  if (!anthropic) return { signed: false, missing: ['(AI validation unavailable — manual review needed)'], complete: false, notes: 'No ANTHROPIC_API_KEY' };
  const fieldList = (requiredFields || []).map((f) => `- ${f}`).join('\n');
  const system = `You verify a signed "Associate Agreement" PDF. For each REQUIRED field, decide if it is filled in (handwritten or typed value present). Also check whether the Associate's signature is present on the signature page. complete=true ONLY if the signature is present AND no required fields are missing. Be practical and do not invent missing fields.`;
  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 512,
      system,
      output_config: { format: { type: 'json_schema', schema: SIGNED_SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: `Applicant: ${name}\nRequired fields:\n${fieldList}\n\nReview the attached signed agreement and report completeness.` },
      ] }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error('[ai] signed validation failed:', err.message);
    return { signed: false, missing: ['(validation error — manual review needed)'], complete: false, notes: err.message };
  }
}

// ── Onboarding-session choice parser ─────────────────────────────────────────────
const CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'id of the chosen onboarding session, or "" if unclear' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['sessionId', 'confidence'],
  additionalProperties: false,
};

async function parseOnboardingChoice(text, sessions) {
  if (!anthropic) {
    const t = (text || '').toLowerCase();
    const hit = (sessions || []).find((s) => s.label.toLowerCase().split(/\W+/).some((w) => w.length > 3 && t.includes(w)));
    return { sessionId: hit?.id || '', confidence: 'low' };
  }
  const opts = (sessions || []).map((s) => `id=${s.id}: ${s.label}${s.date ? ' on ' + s.date : ''}`).join('\n');
  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 128,
      system: "Map the contact's reply to one of the onboarding session options. Return the matching session id, or \"\" if their reply does not clearly pick one.",
      output_config: { format: { type: 'json_schema', schema: CHOICE_SCHEMA } },
      messages: [{ role: 'user', content: `Options:\n${opts}\n\nTheir reply: "${text}"\n\nWhich session id did they pick?` }],
    });
    const r = JSON.parse(res.content.find((b) => b.type === 'text')?.text || '{}');
    if (!(sessions || []).find((s) => s.id === r.sessionId)) r.sessionId = '';
    return r;
  } catch (err) {
    console.error('[ai] onboarding choice parse failed:', err.message);
    return { sessionId: '', confidence: 'low' };
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let sock = null;
let connectionState = 'close'; // 'close' | 'connecting' | 'open'
let currentQR = null;           // base64 QR image
let waReconnects = 0;           // consecutive reconnect failures — halt when blocked/banned

// Outgoing/seen message store so we can answer decryption-retry requests. Without
// this, recipients who can't decrypt a message (common after a reconnect) stay
// stuck on "Waiting for this message" because Baileys can't re-send the original.
const msgStore = new Map(); // message id -> proto message
function rememberMessage(m) {
  if (!m?.key?.id || !m.message) return;
  msgStore.set(m.key.id, m.message);
  if (msgStore.size > 3000) msgStore.delete(msgStore.keys().next().value); // bound memory
}

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

// Spintax outreach — every send renders a slightly different wording (anti-ban).
const OUTREACH_SPINTAX = `{Hi|Hey|Hello|Hi there} [Name], {we connected previously|we were in touch a while back|we'd spoken before|we connected some time ago} regarding a {business/career opportunity|career opportunity|business opportunity|flexible income opportunity}, but I {recently switched to WhatsApp Business|moved over to WhatsApp Business recently|just switched to WhatsApp Business} and lost my chat history.

I'm {updating my records|tidying up my contacts|going through my list} and wanted to {check if|see if|ask if} you're still open to {hearing about opportunities or additional income streams|exploring opportunities or some extra income|hearing about a side-income option}.

{If yes, just reply|If you are, just drop me an|Keen? Just reply} "Interested" and I'll {send you the details|share the details|fill you in}. {If not, no worries and I won't follow up further.|No worries at all if not — I won't keep messaging.|If it's not for you, all good, I won't follow up.}`;

function buildMessage(name) {
  return spin(OUTREACH_SPINTAX).replace(/\[Name\]/g, name);
}

// Extract the sender's real phone from a message's various JID fields (handles
// WhatsApp Business / @lid privacy routing).
function senderPhoneOf(msg) {
  const jids = [msg.key?.remoteJid, msg.key?.remoteJidAlt, msg.key?.participant, msg.key?.participantAlt, msg.key?.senderPn].filter(Boolean);
  const phoneJid = jids.find((j) => j.includes('@s.whatsapp.net'));
  return (phoneJid || '').replace('@s.whatsapp.net', '');
}

// Match an incoming sender phone to a lead (full number, then last-8-digits fallback).
function matchLead(leads, senderPhone) {
  const senderDigits = (senderPhone || '').replace(/\D/g, '');
  return leads.find((l) => {
    const norm = normalisePhone(l.phone) || '';
    if (senderPhone && norm === senderPhone) return true;
    const leadDigits = (l.phone || '').replace(/\D/g, '');
    return senderDigits.length >= 8 && leadDigits.length >= 8 && senderDigits.slice(-8) === leadDigits.slice(-8);
  });
}

// Best-effort plain text of a WA message (document -> placeholder).
function messageText(msg) {
  const docMsg = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || (docMsg ? `[document: ${docMsg.fileName || 'file'}]` : '[media]');
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
    // Identify as a Desktop client — WhatsApp only pushes chat-history sync to
    // desktop-class clients, which the backfill needs.
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: true, // pull chat history on link so the backfill can recover missed replies
    // Answer decryption-retry requests so recipients never get stuck on
    // "Waiting for this message" — re-encrypt and resend the original.
    getMessage: async (key) => msgStore.get(key.id) || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // Backfill: when WhatsApp syncs chat history (e.g. after re-linking the number),
  // capture any lead replies that arrived while the bot was offline, then classify.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    if (!messages?.length) return;
    const leads = readLeads();
    const touched = new Set();
    for (const msg of messages) {
      if (msg.key?.fromMe || !msg.message) continue;
      const lead = matchLead(leads, senderPhoneOf(msg));
      if (!lead) continue;
      const text = messageText(msg);
      if (text === '[media]') continue;
      if (!lead.replies) lead.replies = [];
      if (lead.replies.some((r) => r.text === text)) continue; // dedupe vs existing
      const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
      lead.replies.push({ text, timestamp: ts, backfilled: true });
      touched.add(lead.id);
    }
    if (!touched.size) return;
    for (const id of touched) {
      const l = leads.find((x) => x.id === id);
      l.replies.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
    saveLeads(leads);
    console.log(`[backfill] history sync: ${touched.size} lead(s) got replies — classifying…`);
    for (const id of touched) {
      try {
        const fresh = readLeads();
        const l = fresh.find((x) => x.id === id);
        if (!l?.replies?.length) continue;
        const ai = await classifyReplies(l.name, l.replies);
        l.ai = { ...ai, classifiedAt: new Date().toISOString() };
        if (ai.category === 'interested' && !l.stage) { l.stage = 'brief'; l.wf = { ...(l.wf || {}), enteredAt: new Date().toISOString() }; }
        saveLeads(fresh);
        console.log(`[backfill] #${id} ${l.name}: ${ai.category}`);
      } catch (e) { console.error('[backfill] classify failed for', id, e.message); }
    }
    console.log(`[backfill] done — ${touched.size} lead(s) updated`);
  });

  // Track incoming replies
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) rememberMessage(m); // store ALL (incl. our sent) for retries
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

      const docMsg = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        (docMsg ? `[document: ${docMsg.fileName || 'file'}]` : '[media]');

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
      lead.needsReply = true; // new inbound awaiting a human — drives the "new reply" badge
      saveLeads(leads);
      console.log(`[reply] ${lead.name}: ${text}`);

      // Re-read fresh to avoid stomping concurrent writes.
      const fresh = readLeads();
      const target = fresh.find((l) => l.id === lead.id);
      if (!target) continue;
      const now = () => new Date().toISOString();
      const st = target.status || deriveStatus(target);
      const cfg = readConfig();

      // MANUAL-SEND MODE: classify + advance status (read-only) only. Never auto-send.
      if (['new', 'contacted', 'question', 'review'].includes(st)) {
        // Pre-pipeline triage — classify interest and route to a status.
        const ai = await classifyReplies(target.name, target.replies);
        target.ai = { ...ai, classifiedAt: now() };
        target.status = statusFromCategory(ai.category);
        saveLeads(fresh);
        console.log(`[ai] ${target.name}: ${ai.category} -> ${target.status}`);
      } else if (st === 'invited') {
        // Awaiting attendance confirmation — auto-advance status (no message sent).
        const att = await classifyAttendance(target.name, target.replies);
        target.wf = { ...(target.wf || {}), confirmation: { ...att, detectedAt: now() } };
        if (att.status === 'confirmed' && att.confidence !== 'low') target.status = 'confirmed';
        else if (att.status === 'declined') target.status = 'declined';
        saveLeads(fresh);
        console.log(`[attend] ${target.name}: ${att.status} (${att.confidence}) -> ${target.status}`);
      } else if (st === 'agreement') {
        // Awaiting the signed agreement back — a returned PDF triggers validation.
        const isPdf = docMsg && (docMsg.mimetype || '').toLowerCase().includes('pdf');
        saveLeads(fresh);
        if (isPdf) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const fname = `${target.id}-${Date.now()}.pdf`;
            writeFileSync(join(SIGNED_DIR, fname), buffer);
            const result = await validateSignedAgreement(target.name, buffer.toString('base64'), cfg.requiredFields);
            const f2 = readLeads();
            const t2 = f2.find((l) => l.id === target.id);
            if (t2) {
              t2.wf = t2.wf || {};
              const prev = t2.wf.signed || { attempts: 0, history: [] };
              t2.wf.signed = { attempts: (prev.attempts || 0) + 1, history: [...(prev.history || []), { at: now(), file: fname, ...result }], lastFile: fname, receivedAt: now(), result };
              if (result.complete) t2.status = 'signed'; // incomplete stays 'agreement' (chase sent manually)
              saveLeads(f2);
              console.log(`[signed] ${t2.name}: complete=${result.complete} missing=${(result.missing || []).length} -> ${t2.status}`);
            }
          } catch (err) { console.error('[signed] processing failed:', err.message); }
        }
      } else if (st === 'onboarding') {
        // Awaiting onboarding-session pick — AI parses choice and books (no message sent).
        const r = await parseOnboardingChoice(text, cfg.onboardingSessions);
        if (r.sessionId) {
          target.status = 'booked';
          target.wf = { ...(target.wf || {}), onboardingSession: r.sessionId, onboardingSlottedAt: now() };
          console.log(`[onboarding] ${target.name} picked ${r.sessionId} -> booked`);
        }
        saveLeads(fresh);
      } else {
        // Any other status — keep the reply + needsReply flag, no change.
        saveLeads(fresh);
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
      waReconnects = 0; // healthy connection — reset the failure counter
      console.log('[WA] Connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      connectionState = 'close';
      currentQR = null;
      console.log('[WA] Disconnected, code:', code);

      if (code === DisconnectReason.loggedOut) {
        console.log('[WA] Session ended (logged out) — clearing session for fresh QR');
        try {
          const files = readdirSync(join(__dirname, 'sessions'));
          for (const f of files) rmSync(join(__dirname, 'sessions', f), { recursive: true, force: true });
        } catch {}
      }

      // STOP hammering a blocked/banned endpoint. 403 = WhatsApp has blocked this
      // number/device; also halt after repeated failures. Re-link to retry.
      if (code === 403 || code === DisconnectReason.forbidden) {
        console.log('[WA] 403 Forbidden — number/device is BLOCKED by WhatsApp. Halting reconnects (re-link from the dashboard to retry).');
        return;
      }
      if (++waReconnects > 8) {
        console.log(`[WA] reconnect failed ${waReconnects}x — halting (re-link to retry).`);
        return;
      }
      console.log(`[WA] Reconnecting in 5s… (attempt ${waReconnects})`);
      setTimeout(connectWA, 5000);
    }
  });
}

connectWA();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // base64 document uploads

// Status + QR
app.get('/api/status', (_req, res) => {
  res.json({ state: connectionState, qr: currentQR, ai: !!anthropic, autoReply: readConfig().autoReply, telegram: { state: tgState, username: tgUsername } });
});

// Toggle auto-reply (bot) mode on/off
app.post('/api/autoreply', (req, res) => {
  const enabled = !!req.body.enabled;
  writeConfig({ ...readConfig(), autoReply: enabled });
  console.log(`[config] auto-reply ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ ok: true, autoReply: enabled });
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
  const lead = { id, name, phone, email: email || '', notes: notes || '', adviser: adviser || '', created: new Date().toISOString(), sent: false, sentAt: null, replies: [], status: 'new' };
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

// Logout + unlink: clears the stored session so the reconnect shows a fresh QR
// to link a different number. (The connection.update handler does the reconnect.)
app.post('/api/logout', async (_req, res) => {
  try { if (sock) await sock.logout().catch(() => {}); } catch {}
  try {
    const dir = join(__dirname, 'sessions');
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  } catch {}
  sock = null;
  connectionState = 'close';
  currentQR = null;
  waReconnects = 0;
  setTimeout(connectWA, 1000); // restart the connection attempt (re-link after a halt)
  res.json({ ok: true });
});

// ── Pipeline config (sessions + brief template) ─────────────────────────────────
app.get('/api/config', (_req, res) => res.json(readConfig()));

app.post('/api/config', (req, res) => {
  const next = { ...readConfig() };
  if (Array.isArray(req.body.sessions)) next.sessions = req.body.sessions;
  if (Array.isArray(req.body.onboardingSessions)) next.onboardingSessions = req.body.onboardingSessions;
  if (Array.isArray(req.body.requiredFields)) next.requiredFields = req.body.requiredFields;
  if (typeof req.body.briefTemplate === 'string') next.briefTemplate = req.body.briefTemplate;
  if (typeof req.body.chaseTemplate === 'string') next.chaseTemplate = req.body.chaseTemplate;
  if (typeof req.body.onboardingTemplate === 'string') next.onboardingTemplate = req.body.onboardingTemplate;
  writeConfig(next);
  res.json({ ok: true, config: next });
});

// ── Documents (uploadable agreements) ────────────────────────────────────────────
// Metadata only — the on-disk `file` name is never exposed to the client.
const publicDoc = ({ file, ...meta }) => meta;

app.get('/api/documents', (_req, res) => res.json(readDocs().map(publicDoc)));

app.post('/api/documents', (req, res) => {
  const { name, mimetype, dataBase64 } = req.body;
  if (!name || !dataBase64) return res.status(400).json({ error: 'name and dataBase64 required' });
  let buf;
  try { buf = Buffer.from(dataBase64, 'base64'); } catch { return res.status(400).json({ error: 'bad base64' }); }
  const id = `doc_${Date.now()}`;
  const ext = (name.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0];
  const file = `${id}${ext}`;
  writeFileSync(join(DOCS_DIR, file), buf);
  const docs = readDocs();
  const meta = { id, file, name, mimetype: mimetype || 'application/pdf', size: buf.length, uploadedAt: new Date().toISOString(), isDefault: docs.length === 0 };
  docs.push(meta);
  saveDocs(docs);
  console.log(`[docs] uploaded ${name} (${buf.length} bytes)`);
  res.status(201).json(publicDoc(meta));
});

app.delete('/api/documents/:id', (req, res) => {
  const docs = readDocs();
  const idx = docs.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = docs.splice(idx, 1);
  try { unlinkSync(join(DOCS_DIR, removed.file)); } catch {}
  if (removed.isDefault && docs.length) docs[0].isDefault = true; // promote a new default
  saveDocs(docs);
  res.json({ ok: true });
});

app.post('/api/documents/:id/default', (req, res) => {
  const docs = readDocs();
  if (!docs.find((d) => d.id === req.params.id)) return res.status(404).json({ error: 'not found' });
  docs.forEach((d) => { d.isDefault = d.id === req.params.id; });
  saveDocs(docs);
  res.json({ ok: true });
});

// ── Pipeline stage actions ───────────────────────────────────────────────────────
function findLead(leads, id) { return leads.find((l) => l.id === Number(id)); }

async function sendDocumentsTo(jid, docs, caption) {
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const buf = readFileSync(join(DOCS_DIR, d.file));
    await sock.sendMessage(jid, { document: buf, fileName: d.name, mimetype: d.mimetype || 'application/pdf', caption: i === 0 ? caption : undefined });
    if (i < docs.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }
}

// Send the personalised brief invite -> stage 'brief'
app.post('/api/wf/invite/:id', async (req, res) => {
  if (connectionState !== 'open') return res.status(503).json({ error: 'WhatsApp not connected' });
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });
  try {
    await sock.sendMessage(jid, { text: message });
    const ts = new Date().toISOString();
    lead.stage = 'brief';
    lead.wf = { ...(lead.wf || {}), enteredAt: lead.wf?.enteredAt || ts, invitedAt: ts, inviteText: message };
    if (!lead.sentReplies) lead.sentReplies = [];
    lead.sentReplies.push({ text: message, timestamp: ts, kind: 'brief-invite' });
    saveLeads(leads);
    console.log(`[wf] invite -> ${lead.name}`);
    res.json({ ok: true, lead });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Human approves attendance confirmation -> stage 'confirmed'
app.post('/api/wf/confirm/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'confirmed';
  lead.wf = { ...(lead.wf || {}), confirmedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Mark declined (drops out of the active pipeline)
app.post('/api/wf/decline/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'declined';
  lead.wf = { ...(lead.wf || {}), declinedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Assign a briefing session -> stage 'slotted'
app.post('/api/wf/slot/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'slotted';
  lead.wf = { ...(lead.wf || {}), session: req.body.session || null, slottedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Tag present at the recruitment session -> stage 'attended'
app.post('/api/wf/attend/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'attended';
  lead.wf = { ...(lead.wf || {}), attendedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Send the agreement document(s) over WhatsApp -> stage 'agreement_sent'
app.post('/api/wf/agreement/:id', async (req, res) => {
  if (connectionState !== 'open') return res.status(503).json({ error: 'WhatsApp not connected' });
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });
  const all = readDocs();
  let chosen = Array.isArray(req.body.fileIds) && req.body.fileIds.length
    ? all.filter((d) => req.body.fileIds.includes(d.id))
    : all.filter((d) => d.isDefault);
  if (!chosen.length) chosen = all.slice(0, 1);
  if (!chosen.length) return res.status(400).json({ error: 'no documents available to send' });
  try {
    const caption = req.body.caption || `Hi ${lead.name}, here is the associate agreement. Please review, sign, and send the signed PDF back to me here.`;
    await sendDocumentsTo(jid, chosen, caption);
    const ts = new Date().toISOString();
    lead.stage = 'agreement_sent';
    lead.wf = { ...(lead.wf || {}), agreement: { sentAt: ts, fileIds: chosen.map((d) => d.id), fileNames: chosen.map((d) => d.name) } };
    if (!lead.sentReplies) lead.sentReplies = [];
    lead.sentReplies.push({ text: `[sent agreement: ${chosen.map((d) => d.name).join(', ')}]`, timestamp: ts, kind: 'agreement' });
    saveLeads(leads);
    console.log(`[wf] agreement -> ${lead.name} (${chosen.length} file/s)`);
    res.json({ ok: true, lead });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Assign an onboarding (2nd) session -> 'onboarding_slotted', role = potential on-board
app.post('/api/wf/onboard-slot/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'onboarding_slotted';
  lead.role = 'potential_onboard';
  lead.wf = { ...(lead.wf || {}), onboardingSession: req.body.session || null, onboardingSlottedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Tag present at the onboarding session -> 'onboarded' (On-board / Sales Rep)
app.post('/api/wf/onboard/:id', (req, res) => {
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.stage = 'onboarded';
  lead.role = 'onboard';
  lead.wf = { ...(lead.wf || {}), onboardedAt: new Date().toISOString() };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Generic manual stage move (drag/correction). null clears the stage (back to inbox).
const ROLE_FOR_STAGE = (s) => s === 'onboarded' ? 'onboard' : (s === 'onboarding' || s === 'onboarding_slotted') ? 'potential_onboard' : 'lead';
app.post('/api/wf/stage/:id', (req, res) => {
  const { stage } = req.body;
  if (stage !== null && !STAGES.includes(stage) && stage !== 'declined')
    return res.status(400).json({ error: 'invalid stage' });
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (stage === null) { delete lead.stage; lead.role = 'lead'; }
  else { lead.stage = stage; lead.role = ROLE_FOR_STAGE(stage); }
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// ── Canonical lifecycle endpoints (status is the single source of truth) ─────────

// Set a lead's status (the ONE transition path). Acting on a lead clears needsReply.
app.post('/api/leads/:id/status', (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.status = status;
  lead.needsReply = false;
  if (req.body.contacted) lead.lastContactedAt = new Date().toISOString(); // "mark sent" = we contacted them
  if (req.body.session !== undefined) lead.wf = { ...(lead.wf || {}), session: req.body.session };
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Clear the "new reply" flag without changing status (acknowledge).
app.post('/api/leads/:id/ack', (req, res) => {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.needsReply = false;
  saveLeads(leads);
  res.json({ ok: true, lead });
});

// Manually log an inbound reply the bot missed; classify + route status if pre-pipeline.
app.post('/api/leads/:id/reply', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (!lead.replies) lead.replies = [];
  lead.replies.push({ text, timestamp: new Date().toISOString(), manual: true });
  lead.needsReply = true;
  saveLeads(leads);
  const st = lead.status || deriveStatus(lead);
  if (['new', 'contacted', 'question', 'review'].includes(st) && req.body.classify !== false) {
    try {
      const ai = await classifyReplies(lead.name, lead.replies);
      const fresh = readLeads();
      const t = fresh.find((l) => l.id === lead.id);
      if (t) { t.ai = { ...ai, classifiedAt: new Date().toISOString() }; t.status = statusFromCategory(ai.category); saveLeads(fresh); return res.json({ ok: true, lead: t }); }
    } catch {}
  }
  res.json({ ok: true, lead });
});

// ── Telegram bot (long-poll) — ban-free channel for engaged leads ───────────────
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
let tgState = TG_TOKEN ? 'starting' : 'off';
let tgUsername = '';
let tgOffset = 0;

async function tgCall(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}),
  });
  return r.json();
}
const tgSend = (chatId, text) => tgCall('sendMessage', { chat_id: chatId, text });
const findLeadByTg = (leads, chatId) => leads.find((l) => String(l.telegramChatId) === String(chatId));

function newTgLead(leads, chatId, name) {
  const id = leads.length ? Math.max(...leads.map((l) => l.id)) + 1 : 1;
  const lead = { id, name, phone: '', email: '', notes: 'via Telegram', adviser: '', created: new Date().toISOString(), sent: false, sentAt: null, replies: [], status: 'new', channel: 'telegram', telegramChatId: chatId };
  leads.push(lead);
  return lead;
}

async function processTgMessage(msg) {
  if (!msg.chat || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || 'Telegram user';

  // /start <leadId> deep link binds this chat to an existing lead.
  const m = text.match(/^\/start(?:\s+(\d+))?/);
  if (m) {
    const leads = readLeads();
    let lead = m[1] ? leads.find((l) => l.id === Number(m[1])) : findLeadByTg(leads, chatId);
    if (lead) { lead.telegramChatId = chatId; if (!lead.channel) lead.channel = 'telegram'; }
    else lead = newTgLead(leads, chatId, name);
    saveLeads(leads);
    await tgSend(chatId, `Hi ${lead.name || name}! Thanks for reaching out 🙂 Are you keen to hear about a flexible income opportunity? Just let me know.`);
    return;
  }

  const leads = readLeads();
  let lead = findLeadByTg(leads, chatId) || newTgLead(leads, chatId, name);
  if (!lead.replies) lead.replies = [];
  lead.replies.push({ text, timestamp: new Date().toISOString(), channel: 'telegram' });
  lead.needsReply = true;
  saveLeads(leads);
  console.log(`[tg] ${lead.name}: ${text}`);

  // Triage classify (no auto-send; suggested reply shows in the Inbox for review).
  const st = lead.status || deriveStatus(lead);
  if (['new', 'contacted', 'question', 'review'].includes(st)) {
    try {
      const ai = await classifyReplies(lead.name, lead.replies);
      const f = readLeads(); const t = f.find((l) => l.id === lead.id);
      if (t) { t.ai = { ...ai, classifiedAt: new Date().toISOString() }; t.status = statusFromCategory(ai.category); saveLeads(f); console.log(`[tg] ${lead.name} -> ${t.status}`); }
    } catch (e) { console.error('[tg] classify failed:', e.message); }
  }
}

async function tgPoll() {
  if (!TG_TOKEN) return;
  try {
    const r = await tgCall('getUpdates', { offset: tgOffset, timeout: 25 });
    if (r.ok) {
      tgState = 'open';
      for (const u of r.result || []) { tgOffset = u.update_id + 1; if (u.message) await processTgMessage(u.message).catch((e) => console.error('[tg]', e.message)); }
    } else { tgState = 'error'; }
  } catch (e) { tgState = 'error'; console.error('[tg] poll error:', e.message); }
  setTimeout(tgPoll, 500);
}
if (TG_TOKEN) {
  tgCall('getMe').then((r) => { if (r.ok) { tgUsername = r.result.username; console.log('[tg] bot online: @' + tgUsername); } else console.log('[tg] token invalid'); });
  tgPoll();
}

ensureStatuses(); // one-time idempotent backfill of `status` on existing leads

const PORT = process.env.PORT || 10001;
app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
