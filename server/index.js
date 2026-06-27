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
import { createHmac } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Data dir is env-overridable so tests can point at an isolated temp dir.
const DATA_DIR = process.env.WATAPP_DATA_DIR || join(__dirname, 'data');
// Under test we import this module for its exports without booting WhatsApp,
// Telegram or the HTTP listener. Production never sets NODE_ENV=test.
const BOOT = process.env.NODE_ENV !== 'test';
const LEADS_PATH = join(DATA_DIR, 'leads.json');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const KNOWLEDGE_PATH = join(__dirname, 'knowledge.md');
const DOCS_DIR = join(DATA_DIR, 'documents');
const DOCS_META_PATH = join(DATA_DIR, 'documents.json');
const SIGNED_DIR = join(DATA_DIR, 'signed'); // returned signed agreements
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

async function classifyReplies(name, replies, repName = '', bookUrl = '') {
  const transcript = replies.map((r) => `- ${r.text}`).join('\n');
  if (!anthropic) return classifyKeyword(replies[replies.length - 1]?.text || '');

  const cfg = readConfig();
  const briefing = fmtSessions(cfg.sessions);
  const onboarding = fmtSessions(cfg.onboardingSessions);

  const system = `You are the WhatsApp assistant for a Pet Afterlife SG recruitment outreach. We message contacts asking if they're open to a flexible-income opportunity and to reply "Interested".

Your job: classify each contact's reply, and draft a SHORT reply we can send back — grounded ONLY in the knowledge base below. Never invent prices, commission rates, dates, or commitments. If they're interested or asking to learn more, invite them to one of the upcoming BRIEFING sessions below (the first session — held face to face) and ask which works best. When you mention timing, give the real scheduled dates/times — never guess or offer dates not listed.

=== UPCOMING SESSIONS (offer ONLY these exact dates/times — do not invent others) ===
BRIEFING (1st session, face-to-face) — offer these to anyone newly interested or wanting to learn more:
${briefing || '(none scheduled yet — say a date will be confirmed shortly and ask what timing generally suits)'}

ONBOARDING (2nd session) — offer these ONLY to someone who has already attended a briefing AND completed/returned their signed agreement:
${onboarding || '(none scheduled yet)'}
=== END SESSIONS ===
${bookUrl ? `\nBOOKING LINK — if (and only if) you invite them to pick a session, end your message with this exact link so they can choose a slot themselves:\n${bookUrl}\nPaste the full link verbatim — never alter, shorten, or wrap it.\n` : ''}
VOICE — write the reply like a REAL person texting, never a template:
- Vary your wording EVERY time. Never reuse stock openers ("Great!", "Awesome!") or the same sentence structures. Two replies to two different people must never read alike.
- Sound natural, warm and human — like a friendly colleague texting, not a corporate script. Light and conversational.
- Keep it short for WhatsApp (1-3 sentences). Match their energy. Never pushy.

=== KNOWLEDGE BASE ===
${KNOWLEDGE}
=== END KNOWLEDGE BASE ===`;

  const hint = STYLE_HINTS[Math.floor(Math.random() * STYLE_HINTS.length)];
  const prompt = `Contact name: ${name}${repName ? `\nYou are texting as: ${repName} — introduce or sign off naturally as ${repName} when it fits (e.g. "I'm ${repName}", "— ${repName}"); don't force it into every line.` : ''}
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
  const briefing = fmtSessions(readConfig().sessions);
  const system = `You manage attendance for a recruitment briefing. Invited contacts were asked to confirm whether they'll attend one of these upcoming briefing sessions:
${briefing || '(dates being finalised)'}
Read the contact's replies and decide if they have CONFIRMED they'll attend, DECLINED, or it's still UNCLEAR. Note which session/date they preferred (if any) in your reason.`;
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

// ── Upcoming-session schedule (fed to the bot so it offers only real, future dates)
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Today's date (YYYY-MM-DD) in Singapore time — sessions are planned/attended in SGT.
function todaySG() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
// Human display for one session, mirroring the web's sessionDisplay: weekday + 12h
// time from date/time fields, falling back to the legacy `label`.
function sessionDisplaySrv(s) {
  let weekday = '', dm = '', time12 = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) {
    weekday = _DOW[new Date(s.date + 'T12:00:00Z').getUTCDay()];
    dm = `${Number(s.date.slice(8, 10))} ${_MONTHS[Number(s.date.slice(5, 7)) - 1]}`;
  }
  if (/^\d{1,2}:\d{2}$/.test(s.time || '')) {
    let [h, m] = s.time.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    time12 = `${h}${m ? ':' + String(m).padStart(2, '0') : ''}${ap}`;
  }
  const main = [weekday, time12].filter(Boolean).join(' ');
  if (!main) return s.label || '';
  return dm ? `${main} · ${dm}` : main;
}
// Sessions on/after today, soonest first. Undated sessions count as always-available.
function upcomingSessions(list) {
  const today = todaySG();
  return (list || []).filter((s) => !s.date || s.date >= today).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}
// Bullet list of the upcoming sessions for a prompt; '' when none are scheduled.
function fmtSessions(list) {
  return upcomingSessions(list).map((s) => sessionDisplaySrv(s)).filter(Boolean).map((d) => `• ${d}`).join('\n');
}

// ── Self-serve slot booking — per-lead signed link the bot drops into WhatsApp ────
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://crm.urbanwerkzsg.com').replace(/\/$/, '');
const BOOK_SECRET = process.env.AUTH_SECRET || 'watapp-booking-fallback-secret';
const bookSign = (s) => createHmac('sha256', BOOK_SECRET).update(s).digest('base64url');
function bookingToken(id) { const p = String(id); return `${p}.${bookSign(p)}`; }
function verifyBookingToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const i = tok.lastIndexOf('.'); const p = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!p || bookSign(p) !== sig) return null;
  const id = Number(p); return Number.isInteger(id) ? id : null;
}
function bookingUrl(id) { return `${PUBLIC_URL}/book/${bookingToken(id)}`; }
// Which slot list applies: once they've signed, they pick an ONBOARDING slot; before that, a BRIEFING slot.
const ONBOARDING_STATUSES = ['signed', 'onboarding', 'booked', 'onboarded'];
function bookingKind(lead) { return ONBOARDING_STATUSES.includes(lead.status) ? 'onboarding' : 'briefing'; }
const bookedField = (kind) => (kind === 'onboarding' ? 'onboardingSession' : 'session');
function bookedCount(leads, kind, sessionId) {
  const f = bookedField(kind);
  return leads.filter((l) => l.wf && l.wf[f] === sessionId).length;
}
// Upcoming slots with live availability for the booking page.
function bookingSlots(cfg, leads, kind) {
  const list = kind === 'onboarding' ? cfg.onboardingSessions : cfg.sessions;
  return upcomingSessions(list).map((s) => {
    const booked = bookedCount(leads, kind, s.id);
    const cap = Number(s.capacity) || 0;
    return { id: s.id, display: sessionDisplaySrv(s), capacity: cap, booked, full: cap > 0 && booked >= cap };
  });
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
// ── Multi-number WhatsApp: each linked number is an independent socket ───────────
const conns = new Map(); // numId -> { sock, state, qr, reconnects, label }
function numbersCfg() {
  const n = readConfig().numbers;
  return (n && n.length) ? n : [{ id: 'n1', label: 'Number 1' }];
}
const connState = (id) => conns.get(id)?.state || 'close';
const anyOpen = () => [...conns.values()].some((c) => c.state === 'open');
// The socket to send a lead's message through (its sticky number, else any open one).
function sockForLead(lead) {
  const c = lead?.assignedNumber && conns.get(lead.assignedNumber);
  if (c && c.state === 'open') return c.sock;
  return ([...conns.values()].find((x) => x.state === 'open') || {}).sock || null;
}
const firstSock = () => ([...conns.values()].find((c) => c.state === 'open') || {}).sock;

// The rep/agent name configured on the number a lead is assigned to — woven into
// outbound copy so we introduce ourselves by name. '' when unset (degrades to no name).
function repNameFor(lead) {
  const n = numbersCfg().find((x) => x.id === lead?.assignedNumber);
  return (n && typeof n.repName === 'string' && n.repName.trim()) || '';
}

// ── Delivery-receipt monitoring — auto-detect shadow-banned / non-delivering numbers
// A healthy number's sends get a ✓✓ (DELIVERY_ACK). A shadow-limited number gets
// only a server ack (✓) and never delivers. We track recent sends per number and
// flag any whose delivery rate collapses, so outreach auto-skips it.
const sentMsgs = new Map(); // msgId -> { numId, ts, delivered }
function trackSent(numId, key) { if (numId && key?.id) sentMsgs.set(key.id, { numId, ts: Date.now(), delivered: false }); }
function markDelivered(update) {
  const id = update?.key?.id; if (!id) return;
  const st = update.update?.status;
  const delivered = (typeof st === 'number' && st >= 3) || (typeof st === 'string' && /DELIVERY|READ|PLAYED/i.test(st));
  if (!delivered) return;
  if (sentMsgs.has(id)) sentMsgs.get(id).delivered = true;
  for (const c of conns.values()) {
    if (c.probe && c.probe.id === id && !c.probe.delivered) {
      c.probe.delivered = true; c.probe.deliveredAt = Date.now();
      console.log(`[probe] ${c.label}: recovery probe DELIVERED — number is reaching recipients again`);
      if (c.health === 'undelivered') c.health = 'ok';
    }
  }
}
function evalDeliveryHealth() {
  const now = Date.now();
  const byNum = {};
  for (const [id, m] of sentMsgs) {
    if (now - m.ts > 6 * 60 * 60 * 1000) { sentMsgs.delete(id); continue; } // forget after 6h
    if (now - m.ts < 3 * 60 * 1000) continue;                                // give 3 min to deliver
    const b = byNum[m.numId] || (byNum[m.numId] = { sent: 0, delivered: 0 });
    b.sent++; if (m.delivered) b.delivered++;
  }
  for (const [numId, c] of conns) {
    const stat = byNum[numId];
    if (!stat || stat.sent < 5) continue; // need a sample before judging
    const rate = stat.delivered / stat.sent;
    if (rate < 0.2 && c.health !== 'undelivered') { c.health = 'undelivered'; console.log(`[health] ${c.label}: only ${stat.delivered}/${stat.sent} delivered — FLAGGED not delivering (excluded from outreach)`); }
    else if (rate >= 0.2 && c.health === 'undelivered') { c.health = 'ok'; console.log(`[health] ${c.label}: deliveries recovered (${stat.delivered}/${stat.sent})`); }
  }
}
if (BOOT) setInterval(evalDeliveryHealth, 3 * 60 * 1000);

// ── Recovery probe — periodically test paused/flagged numbers for un-ban ────────
// Sends one message from the number under test to a healthy number and watches
// for the ✓✓ delivery ack. If it lands, the throttle/ban has eased.
function pickControl(excludeId) {
  for (const [numId, c] of conns) {
    const cfg = numbersCfg().find((n) => n.id === numId);
    if (numId !== excludeId && c.state === 'open' && c.phone && !(cfg && cfg.paused) && c.health !== 'undelivered') return c;
  }
  return null;
}
async function probeNumber(numId) {
  const c = conns.get(numId);
  if (!c || c.state !== 'open' || !c.sock || !c.phone) return { error: 'number not connected' };
  const control = pickControl(numId);
  if (!control) return { error: 'need another healthy connected number to receive the probe' };
  try {
    const sent = await c.sock.sendMessage(toJid(control.phone), { text: `(${c.label}) delivery check ${new Date().toISOString().slice(11, 16)} — please ignore` });
    c.probe = { id: sent?.key?.id || null, at: Date.now(), delivered: false, to: control.label };
    console.log(`[probe] ${c.label} -> ${control.label}: sent (awaiting delivery ack)`);
    return { ok: true, to: control.label };
  } catch (e) { c.probe = { id: null, at: Date.now(), delivered: false, error: e.message }; return { error: e.message }; }
}
async function recoveryProbe() {
  for (const [numId, c] of conns) {
    const cfg = numbersCfg().find((n) => n.id === numId);
    if (!((cfg && cfg.paused) || c.health === 'undelivered')) continue;
    // Bring a halted/offline number up just long enough to test it.
    if (c.state !== 'open') { c.reconnects = 0; connectNumber(numId).catch(() => {}); await new Promise((r) => setTimeout(r, 20000)); }
    if (conns.get(numId)?.state === 'open') await probeNumber(numId);
    else console.log(`[probe] ${c.label}: offline — couldn't connect to test this round`);
  }
}
if (BOOT) {
  setInterval(recoveryProbe, 6 * 60 * 60 * 1000); // every 6 hours
  setTimeout(recoveryProbe, 2 * 60 * 1000);       // and once shortly after boot
}

// ── Per-number guardrails: daily caps + warming ─────────────────────────────────
const DEFAULT_CAP = 40;
const todayStr = () => new Date().toISOString().slice(0, 10);
// Warming ramp: a freshly-added number starts at 10/day and grows +10/day to its
// cap. Pre-existing numbers (no addedAt) are treated as fully warm.
function warmCap(num) {
  const cap = num.dailyCap || DEFAULT_CAP;
  if (!num.addedAt) return cap;
  const days = Math.floor((Date.now() - new Date(num.addedAt).getTime()) / 86400000);
  return Math.max(10, Math.min(cap, 10 + days * 10));
}
// How many WhatsApp messages this number has sent today (derived from leads).
function sentTodayFor(numId, leads) {
  const d = todayStr();
  let n = 0;
  for (const l of leads) {
    if (l.assignedNumber !== numId) continue;
    for (const s of (l.sentReplies || [])) if (s.channel === 'whatsapp' && (s.timestamp || '').slice(0, 10) === d) n++;
  }
  return n;
}
// A number that can take an outbound send right now: connected + under its cap.
function numbersWithCapacity(leads) {
  return numbersCfg().filter((n) => { const c = conns.get(n.id); return !n.paused && c?.state === 'open' && c.health !== 'undelivered' && sentTodayFor(n.id, leads) < warmCap(n); });
}

// ── Send window (quiet hours) — outreach only sends 07:00–22:30 SGT ──────────────
// Singapore is a fixed UTC+8 (no DST), so derive minutes-since-midnight directly.
function sgMinutes() {
  const d = new Date();
  return ((d.getUTCHours() * 60 + d.getUTCMinutes()) + 8 * 60) % (24 * 60);
}
const SEND_WINDOW = { start: 7 * 60, end: 22 * 60 + 30 }; // 07:00–22:30
const inSendWindow = () => { const t = sgMinutes(); return t >= SEND_WINDOW.start && t < SEND_WINDOW.end; };

// ── Opt-out detection — a reply asking us to stop ───────────────────────────────
function isOptOut(text) {
  const t = (text || '').toLowerCase().trim();
  if (t === 'stop' || /^stop\b/.test(t)) return true;
  return /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop contacting|don'?t contact|do not contact|leave me alone|not interested at all)\b/.test(t);
}

// ── Sequenced bulk outreach (paced, cap-aware, auto-failover) ───────────────────
const outreach = { running: false, queue: [], sent: 0, failed: 0, startedAt: null };
async function outreachTick() {
  if (!outreach.running) return;
  if (!outreach.queue.length) { outreach.running = false; console.log(`[outreach] complete — ${outreach.sent} sent`); return; }
  // Quiet hours: hold the queue and re-check every 5 min until the window opens.
  if (!inSendWindow()) { console.log('[outreach] outside send window (07:00–22:30 SGT) — holding'); return setTimeout(outreachTick, 5 * 60 * 1000); }
  const leads = readLeads();
  const capacity = numbersWithCapacity(leads);
  if (!capacity.length) { console.log('[outreach] all numbers capped/offline — pausing'); outreach.running = false; return; }

  // Pick the next queued lead and assign it the healthiest number with capacity
  // (fewest sent today → balances load + auto-fails-over off blocked numbers).
  const leadId = outreach.queue.shift();
  const lead = leads.find((l) => l.id === leadId);
  if (!lead || !toJid(lead.phone)) { outreach.failed++; return setTimeout(outreachTick, 200); }
  capacity.sort((a, b) => sentTodayFor(a.id, leads) - sentTodayFor(b.id, leads));
  let numId = lead.assignedNumber;
  if (!numId || !capacity.find((n) => n.id === numId)) numId = capacity[0].id;
  lead.assignedNumber = numId;

  try {
    const sock = conns.get(numId)?.sock;
    const text = buildMessage(lead.name, repNameFor(lead)); // spintax opening — varied every send
    const sent = await sock.sendMessage(toJid(lead.phone), { text });
    trackSent(numId, sent?.key);
    mutateLeads((ls) => {
      const l = ls.find((x) => x.id === lead.id); if (!l) return;
      l.assignedNumber = numId;
      l.sentReplies = l.sentReplies || [];
      l.sentReplies.push({ text, timestamp: new Date().toISOString(), channel: 'whatsapp' });
      l.lastContactedAt = new Date().toISOString();
      l.sent = true; l.sentAt = l.sentAt || new Date().toISOString();
      if (l.status === 'new') l.status = 'contacted';
    });
    outreach.sent++;
    console.log(`[outreach] -> ${lead.name} via ${numId} (${outreach.sent} sent · ${outreach.queue.length} left)`);
  } catch (e) {
    outreach.failed++;
    console.error(`[outreach] send failed for ${lead?.name}:`, e.message);
  }
  // Human-like pacing: 20–50s jitter between sends (anti-ban).
  setTimeout(outreachTick, 20000 + Math.floor(Math.random() * 30000));
}

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

// Atomic read-modify-write: read the freshest leads, apply a SYNC mutation, save —
// with no `await` in between, so concurrent handlers can't clobber each other's
// writes. Always do slow work (AI calls, media downloads) BEFORE calling this.
function mutateLeads(fn) {
  const leads = readLeads();
  fn(leads);
  saveLeads(leads);
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

// Canonicalise a phone for storage: digits only, leading 0/+ stripped, with the
// chosen country code (default SG +65) prepended unless already present.
function canonPhone(raw, cc) {
  let d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, ''); // drop trunk/leading zeros
  const c = ((cc || '65') + '').replace(/\D/g, '') || '65';
  if (d.startsWith(c) && d.length > 8) return d; // already has this country code
  if (d.length === 8) return c + d;              // bare local number → prepend cc
  return d.length >= 10 ? d : c + d;             // long number assumed to include a cc
}

function toJid(phone) {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;
  return `${normalised}@s.whatsapp.net`;
}

// Spintax outreach — every send renders a slightly different wording (anti-ban).
const OUTREACH_SPINTAX = `{Hi|Hey|Hello|Hi there} [Name], [RepIntro]{we connected previously|we were in touch a while back|we'd spoken before|we connected some time ago} regarding a {business/career opportunity|career opportunity|business opportunity|flexible income opportunity}, but I {recently switched to WhatsApp Business|moved over to WhatsApp Business recently|just switched to WhatsApp Business} and lost my chat history.

I'm {updating my records|tidying up my contacts|going through my list} and wanted to {check if|see if|ask if} you're still open to {hearing about opportunities or additional income streams|exploring opportunities or some extra income|hearing about a side-income option}.

{If yes, just reply|If you are, just drop me an|Keen? Just reply} "Interested" and I'll {send you the details|share the details|fill you in}. {If not, no worries and I won't follow up further.|No worries at all if not — I won't keep messaging.|If it's not for you, all good, I won't follow up.}`;

function buildMessage(name, repName = '') {
  return spin(OUTREACH_SPINTAX)
    .replace(/\[Name\]/g, name)
    .replace(/\[RepIntro\]/g, repName ? `I'm ${repName} — ` : '');
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

// The chat partner (the lead) for a message, regardless of direction: in a 1:1
// chat remoteJid is the lead for both inbound and our sent. Falls back to the
// sender extraction (handles @lid privacy routing) when remoteJid isn't a phone.
function chatPhone(msg) {
  const jid = msg?.key?.remoteJid || '';
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (/^\d{6,}$/.test(digits)) return digits;
  return senderPhoneOf(msg);
}

// Record ONE history message onto the matching lead (both directions: our sent →
// sentReplies, theirs → replies), deduped by id-or-text. Mutates `leads` in place;
// returns the touched lead id, or null. Pure given (leads, msg) — unit-tested.
function applyHistoryMessage(leads, msg) {
  if (!msg?.message) return null;
  const lead = matchLead(leads, chatPhone(msg));
  if (!lead) return null;
  const text = messageText(msg);
  if (!text || text === '[media]') return null; // skip contentless media
  const id = msg.key?.id || null;
  const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
  const key = msg.key?.fromMe ? 'sentReplies' : 'replies';
  lead[key] = lead[key] || [];
  if (lead[key].some((r) => (id && r.id === id) || r.text === text)) return null; // dedupe vs live + history
  const entry = { id, text, timestamp: ts, backfilled: true };
  if (msg.key?.fromMe) entry.channel = 'whatsapp';
  lead[key].push(entry);
  return lead.id;
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
async function connectNumber(numId) {
  const label = (numbersCfg().find((n) => n.id === numId) || {}).label || numId;
  const dir = join(__dirname, 'sessions', numId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
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

  const c = conns.get(numId) || { reconnects: 0 };
  c.sock = sock; c.label = label; c.state = 'connecting'; c.qr = null;
  conns.set(numId, c);

  sock.ev.on('creds.update', saveCreds);

  // Backfill: when WhatsApp syncs chat history (e.g. after re-linking the number),
  // capture any lead replies that arrived while the bot was offline, then classify.
  sock.ev.on('messaging-history.set', async ({ messages, syncType, progress }) => {
    if (!messages?.length) return;
    // DIAGNOSTIC: why do some numbers match 0 leads? Log counts + unmatched numbers.
    try {
      const _l = readLeads();
      let _me = 0, _hit = 0; const _miss = new Set();
      for (const m of messages) {
        if (m.key?.fromMe) _me++;
        const p = chatPhone(m);
        if (p && matchLead(_l, p)) _hit++; else _miss.add(p || '(no#)');
      }
      console.log(`[history:${numId}] ${messages.length} msgs syncType=${syncType} progress=${progress} fromMe=${_me} matched=${_hit} unmatched=[${[..._miss].slice(0, 25).join(',')}]`);
    } catch (e) { console.error('[history] diag failed', e.message); }
    const touched = new Set();
    mutateLeads((leads) => {
      for (const msg of messages) {
        const id = applyHistoryMessage(leads, msg); // records BOTH directions, deduped
        if (id != null) touched.add(id);
      }
      for (const id of touched) {
        const l = leads.find((x) => x.id === id);
        l.replies?.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        l.sentReplies?.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }
    });
    if (!touched.size) return;
    console.log(`[backfill] history sync recorded conversation for ${touched.size} lead(s)`);
    // Only (re)classify still-untriaged leads, so a sync NEVER disturbs statuses
    // already set (review / pipeline / closed). Leads with no inbound are skipped.
    for (const id of touched) {
      try {
        const fresh = readLeads();
        const l = fresh.find((x) => x.id === id);
        if (!l || !l.replies?.length) continue;
        if (!['new', 'contacted'].includes(l.status || 'new')) continue;
        const ai = await classifyReplies(l.name, l.replies, repNameFor(l), bookingUrl(l.id));
        mutateLeads((ls) => { const t = ls.find((x) => x.id === id); if (t) { t.ai = { ...ai, classifiedAt: new Date().toISOString() }; t.status = statusFromCategory(ai.category); } });
        console.log(`[backfill] #${id} ${l.name}: ${ai.category} -> ${statusFromCategory(ai.category)}`);
      } catch (e) { console.error('[backfill] classify failed for', id, e.message); }
    }
    console.log(`[backfill] done — ${touched.size} lead(s) synced`);
  });

  // Track incoming replies
  // Delivery receipts: mark our sent messages delivered (drives health monitoring).
  sock.ev.on('messages.update', (updates) => { for (const u of updates) markDelivered(u); });

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
      if (!lead.assignedNumber) lead.assignedNumber = numId; // sticky: bind lead to this number
      if (!lead.channel) lead.channel = 'whatsapp';
      saveLeads(leads);
      console.log(`[reply:${numId}] ${lead.name}: ${text}`);

      // Re-read fresh to avoid stomping concurrent writes.
      const fresh = readLeads();
      const target = fresh.find((l) => l.id === lead.id);
      if (!target) continue;
      const now = () => new Date().toISOString();
      const st = target.status || deriveStatus(target);
      const cfg = readConfig();

      // Opt-out: they asked us to stop — flag and never message again. (Reply was
      // already captured atomically above; just apply the status change.)
      if (isOptOut(text)) { mutateLeads((ls) => { const t = ls.find((l) => l.id === target.id); if (t) { t.status = 'opted_out'; t.needsReply = false; } }); console.log(`[optout] ${target.name} opted out`); continue; }

      // MANUAL-SEND MODE: classify + advance status (read-only) only. Never auto-send.
      // Slow AI runs OUTSIDE the write; the result is applied via mutateLeads (which
      // re-reads fresh) so concurrent replies are never clobbered.
      if (['new', 'contacted', 'question', 'review'].includes(st)) {
        const ai = await classifyReplies(target.name, target.replies, repNameFor(target), bookingUrl(target.id));
        mutateLeads((ls) => { const t = ls.find((l) => l.id === target.id); if (t) { t.ai = { ...ai, classifiedAt: now() }; t.status = statusFromCategory(ai.category); } });
        console.log(`[ai] ${target.name}: ${ai.category} -> ${target.status}`);
      } else if (st === 'invited') {
        const att = await classifyAttendance(target.name, target.replies);
        mutateLeads((ls) => { const t = ls.find((l) => l.id === target.id); if (!t) return; t.wf = { ...(t.wf || {}), confirmation: { ...att, detectedAt: now() } }; if (att.status === 'confirmed' && att.confidence !== 'low') t.status = 'confirmed'; else if (att.status === 'declined') t.status = 'declined'; });
        console.log(`[attend] ${target.name}: ${att.status} (${att.confidence})`);
      } else if (st === 'agreement') {
        const isPdf = docMsg && (docMsg.mimetype || '').toLowerCase().includes('pdf');
        if (isPdf) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const fname = `${target.id}-${Date.now()}.pdf`;
            writeFileSync(join(SIGNED_DIR, fname), buffer);
            const result = await validateSignedAgreement(target.name, buffer.toString('base64'), cfg.requiredFields);
            mutateLeads((ls) => {
              const t2 = ls.find((l) => l.id === target.id);
              if (!t2) return;
              t2.wf = t2.wf || {};
              const prev = t2.wf.signed || { attempts: 0, history: [] };
              t2.wf.signed = { attempts: (prev.attempts || 0) + 1, history: [...(prev.history || []), { at: now(), file: fname, ...result }], lastFile: fname, receivedAt: now(), result };
              if (result.complete) t2.status = 'signed';
            });
            console.log(`[signed] ${target.name}: complete=${result.complete} missing=${(result.missing || []).length}`);
          } catch (err) { console.error('[signed] processing failed:', err.message); }
        }
      } else if (st === 'onboarding') {
        const r = await parseOnboardingChoice(text, cfg.onboardingSessions);
        if (r.sessionId) {
          mutateLeads((ls) => { const t = ls.find((l) => l.id === target.id); if (t) { t.status = 'booked'; t.wf = { ...(t.wf || {}), onboardingSession: r.sessionId, onboardingSlottedAt: now() }; } });
          console.log(`[onboarding] ${target.name} picked ${r.sessionId} -> booked`);
        }
      }
      // else: reply already captured atomically; nothing more to write.
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const cc = conns.get(numId);
    if (!cc) return;
    if (qr) { cc.qr = await qrcode.toDataURL(qr); cc.state = 'connecting'; console.log(`[WA:${label}] QR generated`); }
    if (connection === 'open') {
      cc.state = 'open'; cc.qr = null;
      cc.phone = (sock.user?.id || '').split(/[:@]/)[0] || null;
      // Only reset the retry counter once the connection has held for 60s — a number
      // that flaps (open → immediate drop) keeps its counter so it backs off + halts.
      clearTimeout(cc.stableTimer);
      cc.stableTimer = setTimeout(() => { cc.reconnects = 0; }, 60000);
      console.log(`[WA:${label}] Connected${cc.phone ? ' as ' + cc.phone : ''}`);
    }
    if (connection === 'close') {
      clearTimeout(cc.stableTimer);
      const code = lastDisconnect?.error?.output?.statusCode;
      cc.state = 'close'; cc.qr = null;
      console.log(`[WA:${label}] Disconnected, code: ${code}`);
      if (code === DisconnectReason.loggedOut) {
        try { for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true }); } catch {}
      }
      if (code === 403 || code === DisconnectReason.forbidden) { cc.state = 'banned'; console.log(`[WA:${label}] 403 BLOCKED by WhatsApp — halting (relink to retry).`); return; }
      if (++cc.reconnects > 8) { console.log(`[WA:${label}] unstable — halting after ${cc.reconnects} flaps (re-link or the 6h probe will retry).`); return; }
      const delay = Math.min(120000, 5000 * cc.reconnects); // back off: 5s,10s,15s… up to 2m
      console.log(`[WA:${label}] Reconnecting in ${delay / 1000}s… (attempt ${cc.reconnects})`);
      setTimeout(() => connectNumber(numId), delay);
    }
  });
}

// Connect all configured numbers on boot.
if (BOOT) for (const n of numbersCfg()) connectNumber(n.id).catch((e) => console.error('[wa] connect failed', n.id, e.message));

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // base64 document uploads

// Status + QR
app.get('/api/status', (_req, res) => {
  const leadsForCount = readLeads();
  const numbers = numbersCfg().map((n) => { const c = conns.get(n.id) || {}; return { id: n.id, label: c.label || n.label, repName: n.repName || '', state: c.state || 'close', qr: c.qr || null, phone: c.phone || null, health: c.health || 'ok', paused: !!n.paused, probe: c.probe || null, sentToday: sentTodayFor(n.id, leadsForCount), cap: warmCap(n) }; });
  const state = anyOpen() ? 'open' : (numbers.some((n) => n.state === 'connecting') ? 'connecting' : 'close');
  const qr = (numbers.find((n) => n.state === 'connecting' && n.qr) || {}).qr || null;
  res.json({ state, qr, numbers, ai: !!anthropic, autoReply: readConfig().autoReply, telegram: { state: tgState, username: tgUsername }, outreach: { running: outreach.running, queued: outreach.queue.length, sent: outreach.sent, failed: outreach.failed, windowOpen: inSendWindow() } });
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
    const ai = await classifyReplies(lead.name, lead.replies, repNameFor(lead), bookingUrl(lead.id));
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
  if (!anyOpen()) {
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
    await firstSock().sendMessage(jid, { text: message });
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

  const ai = await classifyReplies(lead.name, lead.replies, repNameFor(lead), bookingUrl(lead.id));
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
  const { name, email, notes, adviser, force } = req.body;
  const phone = canonPhone(req.body.phone, req.body.cc);
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  const leads = readLeads();

  // Duplicate detection — same phone (last-8 digits) or same name (case-insensitive).
  if (!force) {
    const digits = (phone || '').replace(/\D/g, '');
    const dups = leads.filter((l) => {
      const ld = (l.phone || '').replace(/\D/g, '');
      const phoneMatch = digits.length >= 8 && ld.length >= 8 && ld.slice(-8) === digits.slice(-8);
      const nameMatch = !!name && !!l.name && l.name.trim().toLowerCase() === name.trim().toLowerCase();
      return phoneMatch || nameMatch;
    });
    if (dups.length) {
      const d = dups[0];
      const ld = (d.phone || '').replace(/\D/g, '');
      const by = digits.length >= 8 && ld.length >= 8 && ld.slice(-8) === digits.slice(-8) ? 'phone' : 'name';
      return res.status(409).json({ duplicate: true, matchedBy: by, count: dups.length, existing: { id: d.id, name: d.name, phone: d.phone, status: d.status } });
    }
  }

  const id = leads.length ? Math.max(...leads.map((l) => l.id)) + 1 : 1;
  const lead = { id, name, phone, email: email || '', notes: notes || '', adviser: adviser || '', created: new Date().toISOString(), sent: false, sentAt: null, replies: [], status: 'new' };
  leads.unshift(lead);
  saveLeads(leads);
  res.status(201).json(lead);
});

// Bulk CSV import — creates leads, skipping duplicates (by phone last-8, else name)
// against existing leads AND within the batch. Returns an added/skipped summary.
app.post('/api/leads/import', (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'no rows' });
  const leads = readLeads();
  const keyOf = (name, phone) => { const d = (phone || '').replace(/\D/g, ''); return d.length >= 8 ? 'p:' + d.slice(-8) : (name ? 'n:' + name.trim().toLowerCase() : null); };
  const exist = new Set();
  leads.forEach((l) => { const d = (l.phone || '').replace(/\D/g, ''); if (d.length >= 8) exist.add('p:' + d.slice(-8)); if (l.name) exist.add('n:' + l.name.trim().toLowerCase()); });
  const seen = new Set();
  let nextId = leads.length ? Math.max(...leads.map((l) => l.id)) + 1 : 1;
  let added = 0; const skipped = [];
  for (const r of rows) {
    const name = (r.name || '').trim(); const phone = canonPhone(r.phone, '65');
    if (!name && !phone) { skipped.push({ name, phone, reason: 'empty' }); continue; }
    const k = keyOf(name, phone);
    if (k && (exist.has(k) || seen.has(k))) { skipped.push({ name, phone, reason: 'duplicate' }); continue; }
    if (k) seen.add(k);
    leads.unshift({ id: nextId++, name, phone, email: (r.email || '').trim(), notes: (r.notes || '').trim(), adviser: (r.adviser || '').trim(), created: new Date().toISOString(), sent: false, sentAt: null, replies: [], status: 'new' });
    added++;
  }
  saveLeads(leads);
  console.log(`[import] +${added} leads, ${skipped.length} skipped (of ${rows.length})`);
  res.json({ ok: true, added, skipped, total: rows.length });
});

// Mark lead sent/unsent
app.patch('/api/leads/:id', (req, res) => {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.phone === 'string') req.body.phone = canonPhone(req.body.phone, req.body.cc);
  delete req.body.cc;
  Object.assign(lead, req.body);
  saveLeads(leads);
  res.json(lead);
});

// Permanently remove a lead from the system (Directory "Remove" action).
app.delete('/api/leads/:id', (req, res) => {
  const id = Number(req.params.id);
  let removed = null;
  mutateLeads((ls) => { const i = ls.findIndex((l) => l.id === id); if (i !== -1) removed = ls.splice(i, 1)[0]; });
  if (!removed) return res.status(404).json({ error: 'not found' });
  console.log(`[lead] removed ${removed.name} (#${id})`);
  res.json({ ok: true, removed: { id: removed.id, name: removed.name } });
});

// ── Self-serve booking (PUBLIC, token-gated) — the /book/<token> page calls these.
// A lead opens their unique link and picks a slot; capacity is enforced and the
// pick advances their pipeline status (briefing→scheduled, onboarding→booked).
app.get('/api/book/:token', (req, res) => {
  const id = verifyBookingToken(req.params.token);
  if (id == null) return res.status(404).json({ error: 'This booking link is invalid or has expired.' });
  const leads = readLeads();
  const lead = leads.find((l) => l.id === id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const cfg = readConfig();
  const kind = bookingKind(lead);
  res.json({
    name: lead.name,
    kind, // 'briefing' | 'onboarding'
    slots: bookingSlots(cfg, leads, kind),
    current: (lead.wf && lead.wf[bookedField(kind)]) || null,
  });
});

app.post('/api/book/:token', (req, res) => {
  const id = verifyBookingToken(req.params.token);
  if (id == null) return res.status(404).json({ error: 'This booking link is invalid or has expired.' });
  const sessionId = req.body.sessionId;
  const leads = readLeads();
  const lead = leads.find((l) => l.id === id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const cfg = readConfig();
  const kind = bookingKind(lead);
  const list = kind === 'onboarding' ? cfg.onboardingSessions : cfg.sessions;
  const slot = upcomingSessions(list).find((s) => s.id === sessionId);
  if (!slot) return res.status(400).json({ error: 'That slot is no longer available — please pick another.' });
  const f = bookedField(kind);
  const already = lead.wf && lead.wf[f] === sessionId;
  const cap = Number(slot.capacity) || 0;
  if (cap > 0 && bookedCount(leads, kind, sessionId) >= cap && !already) {
    return res.status(409).json({ error: 'Sorry, that slot just filled up — please pick another.' });
  }
  mutateLeads((ls) => {
    const l = ls.find((x) => x.id === id);
    if (!l) return;
    l.wf = l.wf || {};
    l.wf[f] = sessionId;
    l.wf.bookedAt = new Date().toISOString();
    l.status = kind === 'onboarding' ? 'booked' : 'scheduled';
    l.needsReply = false;
  });
  console.log(`[book] ${lead.name} (#${id}) booked ${kind} slot ${sessionId} -> ${kind === 'onboarding' ? 'booked' : 'scheduled'}`);
  res.json({ ok: true, kind, display: sessionDisplaySrv(slot) });
});

// Bulk send — must be registered BEFORE /api/send/:id to avoid route shadowing
const BATCH_SIZE = 40;
const BATCH_PAUSE = 30000; // 30s between batches

app.post('/api/send/bulk', async (req, res) => {
  if (!anyOpen()) {
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

      const message = customMessage || buildMessage(lead.name, repNameFor(lead));

      try {
        await firstSock().sendMessage(jid, { text: message });
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
  if (!anyOpen()) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });

  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });

  const message = req.body.message || buildMessage(lead.name, repNameFor(lead));

  try {
    await firstSock().sendMessage(jid, { text: message });
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
// Relink a number: clear its session + reconnect (fresh QR). Used after a block.
async function relinkNumber(numId) {
  const c = conns.get(numId);
  try { if (c?.sock) await c.sock.logout().catch(() => {}); } catch {}
  try { const dir = join(__dirname, 'sessions', numId); for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true }); } catch {}
  if (c) { c.state = 'close'; c.qr = null; c.reconnects = 0; }
  setTimeout(() => connectNumber(numId), 1000);
}

// Legacy single re-link (dashboard pill) -> relink the first number.
app.post('/api/logout', async (_req, res) => {
  await relinkNumber(numbersCfg()[0].id);
  res.json({ ok: true });
});

// ── Numbers management (multi-number) ───────────────────────────────────────────
const numberView = (n) => { const c = conns.get(n.id) || {}; return { id: n.id, label: c.label || n.label, repName: n.repName || '', state: c.state || 'close', qr: c.qr || null, phone: c.phone || null }; };
app.get('/api/numbers', (_req, res) => res.json(numbersCfg().map(numberView)));

app.post('/api/numbers', (req, res) => {
  const nums = numbersCfg();
  if (nums.length >= 10) return res.status(400).json({ error: 'max 10 numbers' });
  const id = 'n' + Date.now().toString(36);
  const label = (req.body.label || `Number ${nums.length + 1}`).trim();
  const repName = (req.body.repName || '').trim();
  writeConfig({ ...readConfig(), numbers: [...nums, { id, label, repName, addedAt: new Date().toISOString(), dailyCap: DEFAULT_CAP }] });
  connectNumber(id).catch((e) => console.error('[wa] connect failed', id, e.message));
  res.status(201).json({ id, label, repName });
});

app.post('/api/numbers/:id/relink', async (req, res) => {
  if (!numbersCfg().find((n) => n.id === req.params.id)) return res.status(404).json({ error: 'not found' });
  await relinkNumber(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/numbers/:id', async (req, res) => {
  const id = req.params.id;
  const c = conns.get(id);
  try { if (c?.sock) await c.sock.logout().catch(() => {}); } catch {}
  try { const dir = join(__dirname, 'sessions', id); rmSync(dir, { recursive: true, force: true }); } catch {}
  conns.delete(id);
  writeConfig({ ...readConfig(), numbers: numbersCfg().filter((n) => n.id !== id) });
  res.json({ ok: true });
});

// Evenly + randomly distribute the leads that still need contacting across the
// available numbers (connected ones, else all configured). Almost-equal counts.
app.post('/api/numbers/distribute', (req, res) => {
  const cfgNums = numbersCfg();
  let nums = cfgNums.filter((n) => conns.get(n.id)?.state === 'open');
  if (!nums.length) nums = cfgNums;
  if (!nums.length) return res.status(400).json({ error: 'no numbers configured' });

  const CLOSED = ['declined', 'opted_out', 'onboarded'];
  const validIds = new Set(cfgNums.map((n) => n.id));
  const leads = readLeads();
  const active = leads.filter((l) => l.channel !== 'telegram' && !CLOSED.includes(l.status || 'new'));
  // Sticky agents: NEVER move a lead already tagged to a real number/agent. Only
  // assign leads that are unassigned or orphaned (pointing at a number that no
  // longer exists). The rep stays with the lead even if numbers are added/removed.
  const eligible = active.filter((l) => !l.assignedNumber || !validIds.has(l.assignedNumber));
  const kept = active.length - eligible.length;
  for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; } // shuffle
  const counts = {};
  eligible.forEach((l, i) => { const id = nums[i % nums.length].id; l.assignedNumber = id; counts[id] = (counts[id] || 0) + 1; });
  saveLeads(leads);
  console.log(`[distribute] assigned ${eligible.length} unassigned lead(s) across ${nums.length} number(s); kept ${kept} already tagged`);
  res.json({ ok: true, total: eligible.length, kept, numbers: nums.map((n) => ({ id: n.id, label: n.label, count: counts[n.id] || 0 })) });
});

// Set a number's daily cap (warming still applies on top for new numbers).
app.patch('/api/numbers/:id', (req, res) => {
  const nums = numbersCfg();
  const n = nums.find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  if (req.body.dailyCap != null) n.dailyCap = Math.max(1, Math.min(200, Number(req.body.dailyCap) || DEFAULT_CAP));
  if (typeof req.body.label === 'string' && req.body.label.trim()) n.label = req.body.label.trim();
  if (typeof req.body.repName === 'string') n.repName = req.body.repName.trim(); // '' clears it
  if (typeof req.body.paused === 'boolean') n.paused = req.body.paused;
  writeConfig({ ...readConfig(), numbers: nums });
  res.json({ ok: true });
});

// Manually run a delivery probe on a number ("test now").
app.post('/api/numbers/:id/probe', async (req, res) => { const r = await probeNumber(req.params.id); res.status(r.ok ? 200 : 400).json(r); });

// ── Sequenced outreach control ──────────────────────────────────────────────────
// Start paced outreach to a set of leads (default: all 'new' WhatsApp leads).
app.post('/api/outreach/start', (req, res) => {
  if (outreach.running) return res.status(409).json({ error: 'outreach already running' });
  const ids = Array.isArray(req.body.leadIds) ? req.body.leadIds : null;
  const leads = readLeads();
  let targets = ids ? leads.filter((l) => ids.includes(l.id)) : leads.filter((l) => l.status === 'new' && l.channel !== 'telegram');
  targets = targets.filter((l) => toJid(l.phone) && l.status !== 'opted_out');
  if (!targets.length) return res.status(400).json({ error: 'no eligible leads (need a valid phone, WhatsApp channel)' });
  if (!numbersWithCapacity(leads).length) return res.status(503).json({ error: 'no connected number has capacity right now' });
  outreach.queue = targets.map((l) => l.id);
  outreach.sent = 0; outreach.failed = 0; outreach.running = true; outreach.startedAt = new Date().toISOString();
  console.log(`[outreach] starting — ${outreach.queue.length} leads`);
  setTimeout(outreachTick, 500);
  res.json({ ok: true, queued: outreach.queue.length });
});
app.get('/api/outreach/status', (_req, res) => {
  const leads = readLeads();
  res.json({ running: outreach.running, queued: outreach.queue.length, sent: outreach.sent, failed: outreach.failed, startedAt: outreach.startedAt,
    numbers: numbersCfg().map((n) => ({ id: n.id, label: n.label, sentToday: sentTodayFor(n.id, leads), cap: warmCap(n), dailyCap: n.dailyCap || DEFAULT_CAP, state: conns.get(n.id)?.state || 'close' })) });
});
app.post('/api/outreach/stop', (_req, res) => { const left = outreach.queue.length; outreach.running = false; outreach.queue = []; console.log(`[outreach] stopped — ${left} unsent`); res.json({ ok: true, cleared: left }); });

// Bulk lead actions: set status or (re)assign a number for many leads at once.
app.post('/api/leads/bulk', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const { action, value } = req.body;
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const leads = readLeads();
  let updated = 0;
  for (const l of leads) {
    if (!ids.includes(l.id)) continue;
    if (action === 'status' && value) { l.status = value; if (value !== 'new') l.needsReply = false; updated++; }
    else if (action === 'assign') { l.assignedNumber = value || null; updated++; }
  }
  saveLeads(leads);
  res.json({ ok: true, updated });
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

async function sendDocumentsTo(jid, docs, caption, sock) {
  const s = sock || firstSock();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const buf = readFileSync(join(DOCS_DIR, d.file));
    await s.sendMessage(jid, { document: buf, fileName: d.name, mimetype: d.mimetype || 'application/pdf', caption: i === 0 ? caption : undefined });
    if (i < docs.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }
}

// Send the personalised brief invite -> stage 'brief'
app.post('/api/wf/invite/:id', async (req, res) => {
  if (!anyOpen()) return res.status(503).json({ error: 'WhatsApp not connected' });
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });
  try {
    await firstSock().sendMessage(jid, { text: message });
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
  if (!anyOpen()) return res.status(503).json({ error: 'WhatsApp not connected' });
  const leads = readLeads();
  const lead = findLead(leads, req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'invalid phone number' });
  // Send from the lead's OWN sticky number so the agreement lands in the same
  // thread the rep has been chatting in (not a random firstSock number).
  const sock = sockForLead(lead);
  if (!sock) return res.status(503).json({ error: 'No connected WhatsApp number available for this lead.' });
  const all = readDocs();
  let chosen = Array.isArray(req.body.fileIds) && req.body.fileIds.length
    ? all.filter((d) => req.body.fileIds.includes(d.id))
    : all.filter((d) => d.isDefault);
  if (!chosen.length) chosen = all.slice(0, 1);
  if (!chosen.length) return res.status(400).json({ error: 'no documents available to send' });
  try {
    const rep = repNameFor(lead);
    const caption = req.body.caption || `Hi ${lead.name},${rep ? ` I'm ${rep}.` : ''} Here is the associate agreement. Please review, sign, and send the signed PDF back to me here.`;
    await sendDocumentsTo(jid, chosen, caption, sock);
    const ts = new Date().toISOString();
    lead.stage = 'agreement_sent';
    lead.status = 'agreement';
    lead.wf = { ...(lead.wf || {}), agreement: { sentAt: ts, fileIds: chosen.map((d) => d.id), fileNames: chosen.map((d) => d.name) } };
    lead.lastContactedAt = ts;
    if (!lead.sentReplies) lead.sentReplies = [];
    lead.sentReplies.push({ text: caption, timestamp: ts, channel: 'whatsapp', kind: 'agreement' });
    lead.sentReplies.push({ text: `[attached: ${chosen.map((d) => d.name).join(', ')}]`, timestamp: ts, channel: 'whatsapp', kind: 'agreement' });
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
      const ai = await classifyReplies(lead.name, lead.replies, repNameFor(lead), bookingUrl(lead.id));
      const fresh = readLeads();
      const t = fresh.find((l) => l.id === lead.id);
      if (t) { t.ai = { ...ai, classifiedAt: new Date().toISOString() }; t.status = statusFromCategory(ai.category); saveLeads(fresh); return res.json({ ok: true, lead: t }); }
    } catch {}
  }
  res.json({ ok: true, lead });
});

// Send a reply through the lead's channel. Telegram sends directly (ban-free);
// WhatsApp is manual-send (reply from your phone). Logs the send + last-contacted.
app.post('/api/leads/:id/send', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (lead.channel === 'telegram' && lead.telegramChatId) {
    const r = await tgSend(lead.telegramChatId, text);
    if (!r || !r.ok) return res.status(502).json({ error: 'Telegram send failed: ' + ((r && r.description) || 'unknown') });
    mutateLeads((ls) => { const l = ls.find((x) => x.id === lead.id); if (!l) return; l.sentReplies = l.sentReplies || []; l.sentReplies.push({ text, timestamp: new Date().toISOString(), channel: 'telegram' }); l.lastContactedAt = new Date().toISOString(); l.needsReply = false; });
    return res.json({ ok: true });
  }
  // Compliance: never message someone who opted out.
  if (lead.status === 'opted_out') return res.status(400).json({ error: 'This lead opted out — messaging is blocked.' });
  // WhatsApp send via the lead's sticky number. Anti-ban: each message is the
  // AI's per-lead reply (generated with high variation) so no two are alike.
  const sock = sockForLead(lead);
  if (!sock) return res.status(503).json({ error: 'No connected WhatsApp number available for this lead.' });
  const jid = toJid(lead.phone);
  if (!jid) return res.status(400).json({ error: 'Lead has no valid phone number.' });
  const fromNum = lead.assignedNumber || (([...conns.entries()].find(([, v]) => v.sock === sock) || [])[0]);
  try {
    const sent = await sock.sendMessage(jid, { text });
    trackSent(fromNum, sent?.key);
    mutateLeads((ls) => { const l = ls.find((x) => x.id === lead.id); if (!l) return; l.sentReplies = l.sentReplies || []; l.sentReplies.push({ text, timestamp: new Date().toISOString(), channel: 'whatsapp' }); l.lastContactedAt = new Date().toISOString(); l.needsReply = false; if (!l.assignedNumber && fromNum) l.assignedNumber = fromNum; });
    return res.json({ ok: true });
  } catch (e) { return res.status(502).json({ error: 'WhatsApp send failed: ' + e.message }); }
});

// Generate a fresh, varied suggested reply for a lead (so no two are similar —
// avoids WhatsApp flagging templated bulk sends). Contextual for leads who have
// replied; a spintax opening for not-yet-contacted leads. Stores on the lead.
app.post('/api/leads/:id/suggest', async (req, res) => {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'not found' });
  try {
    let suggested;
    if (lead.replies?.length) {
      const ai = await classifyReplies(lead.name, lead.replies, repNameFor(lead), bookingUrl(lead.id));
      suggested = ai.suggested_reply;
      const f = readLeads(); const t = f.find((l) => l.id === lead.id);
      if (t) { t.ai = { ...ai, classifiedAt: new Date().toISOString() }; saveLeads(f); }
    } else {
      suggested = buildMessage(lead.name, repNameFor(lead)); // spintax opening — different every call
      const f = readLeads(); const t = f.find((l) => l.id === lead.id);
      if (t) { t.ai = { ...(t.ai || {}), suggested_reply: suggested, classifiedAt: new Date().toISOString() }; saveLeads(f); }
    }
    return res.json({ ok: true, suggested_reply: suggested });
  } catch (e) { return res.status(500).json({ error: 'suggest failed: ' + e.message }); }
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
  // Opt-out: they asked us to stop — flag and don't auto-reply.
  if (isOptOut(text)) { lead.status = 'opted_out'; lead.needsReply = false; saveLeads(leads); console.log(`[tg][optout] ${lead.name} opted out`); return; }
  saveLeads(leads);
  console.log(`[tg] ${lead.name}: ${text}`);

  // Telegram is ban-free, so the bot CONVERSES: classify, advance status if it's
  // still in triage, and auto-reply with the humanised drafted message.
  try {
    const ai = await classifyReplies(lead.name, lead.replies, repNameFor(lead), bookingUrl(lead.id));
    const f = readLeads(); const t = f.find((l) => l.id === lead.id);
    if (!t) return;
    t.ai = { ...ai, classifiedAt: new Date().toISOString() };
    const st = t.status || deriveStatus(t);
    if (['new', 'contacted', 'question', 'review'].includes(st)) t.status = statusFromCategory(ai.category);
    if (ai.suggested_reply && ai.category !== 'not_interested') {
      if (!t.sentReplies) t.sentReplies = [];
      t.sentReplies.push({ text: ai.suggested_reply, timestamp: new Date().toISOString(), channel: 'telegram', auto: true });
      t.lastContactedAt = new Date().toISOString();
      t.needsReply = false; // bot handled it (still visible in the lead's history)
    }
    saveLeads(f);
    if (ai.suggested_reply && ai.category !== 'not_interested') { await tgSend(chatId, ai.suggested_reply); console.log(`[tg] auto-reply -> ${lead.name}: ${ai.suggested_reply.slice(0, 50)}`); }
    console.log(`[tg] ${lead.name} -> ${t.status}`);
  } catch (e) { console.error('[tg] classify/reply failed:', e.message); }
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
if (BOOT && TG_TOKEN) {
  tgCall('getMe').then((r) => { if (r.ok) { tgUsername = r.result.username; console.log('[tg] bot online: @' + tgUsername); } else console.log('[tg] token invalid'); });
  tgPoll();
}

if (BOOT) {
  ensureStatuses(); // one-time idempotent backfill of `status` on existing leads
  const PORT = process.env.PORT || 10001;
  app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
}

// ── Test surface ────────────────────────────────────────────────────────────────
// Exported for unit/integration tests (see server/test/). Importing this module
// with NODE_ENV=test yields these without booting WhatsApp/Telegram/the listener.
export {
  app, conns,
  deriveStatus, statusFromCategory, normalisePhone, canonPhone, toJid, isOptOut,
  spin, buildMessage, senderPhoneOf, matchLead, messageText, warmCap, sentTodayFor,
  inSendWindow, classifyKeyword, attendKeyword, readLeads, saveLeads, mutateLeads,
  readConfig, writeConfig, ensureStatuses, sockForLead, firstSock, numbersCfg,
  upcomingSessions, fmtSessions, sessionDisplaySrv, todaySG,
  bookingToken, verifyBookingToken, bookingUrl, bookingKind, bookingSlots,
  applyHistoryMessage, chatPhone,
};
