import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
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

Your job: classify each contact's reply, and draft a SHORT, warm, factual reply we can send back — grounded ONLY in the knowledge base below. Never invent prices, commission rates, dates, or commitments. If they're interested or asking to learn more, invite them to a briefing session (Thursday 7:30pm or Sunday 2pm) and ask which suits them. Keep replies concise and natural for WhatsApp (1-4 sentences). This is emotionally sensitive work — be calm and never pushy.

=== KNOWLEDGE BASE ===
${KNOWLEDGE}
=== END KNOWLEDGE BASE ===`;

  const prompt = `Contact name: ${name}
Their reply/replies:
${transcript}

Classify their response and draft the reply to send back.`;

  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
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
      saveLeads(leads);
      console.log(`[reply] ${lead.name}: ${text}`);

      // Re-read fresh to avoid stomping concurrent writes.
      const fresh = readLeads();
      const target = fresh.find((l) => l.id === lead.id);
      if (!target) continue;
      const now = () => new Date().toISOString();
      const invited = target.stage === 'brief' && target.wf?.invitedAt;

      if (invited) {
        // Already invited to the briefing — classify whether they confirmed attendance.
        const att = await classifyAttendance(target.name, target.replies);
        target.wf = { ...(target.wf || {}), confirmation: { ...att, detectedAt: now() } };
        saveLeads(fresh);
        console.log(`[attend] ${target.name}: ${att.status} (${att.confidence})`);
        // No auto-reply once invited — attendance confirmation is approved by a human.
      } else if (target.stage === 'agreement_sent') {
        // Awaiting the signed agreement back. A returned PDF triggers auto-validation.
        const isPdf = docMsg && (docMsg.mimetype || '').toLowerCase().includes('pdf');
        saveLeads(fresh); // keep the reply record either way
        if (isPdf) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const fname = `${target.id}-${Date.now()}.pdf`;
            writeFileSync(join(SIGNED_DIR, fname), buffer);
            const cfg = readConfig();
            const result = await validateSignedAgreement(target.name, buffer.toString('base64'), cfg.requiredFields);

            const f2 = readLeads();
            const t2 = f2.find((l) => l.id === target.id);
            if (t2) {
              t2.wf = t2.wf || {};
              const prev = t2.wf.signed || { attempts: 0, history: [] };
              t2.wf.signed = { attempts: (prev.attempts || 0) + 1, history: [...(prev.history || []), { at: now(), file: fname, ...result }], lastFile: fname, receivedAt: now(), result };
              const jid = toJid(t2.phone);
              if (result.complete) {
                // ✓ complete + signed -> auto thank-you + onboarding options, role -> potential on-board
                t2.stage = 'onboarding';
                t2.role = 'potential_onboard';
                t2.wf.onboardingOfferedAt = now();
                const offer = (cfg.onboardingTemplate || '').replace(/\[Name\]/g, t2.name).replace(/\[Sessions\]/g, fmtSessionList(cfg.onboardingSessions));
                if (!t2.sentReplies) t2.sentReplies = [];
                t2.sentReplies.push({ text: offer, timestamp: now(), auto: true, kind: 'onboarding-offer' });
                saveLeads(f2);
                if (jid) { try { await sock.sendMessage(jid, { text: offer }); } catch {} }
                console.log(`[wf] ${t2.name} agreement COMPLETE -> onboarding (potential on-board)`);
              } else {
                // ✗ missing fields -> auto-chase
                const missingBlock = (result.missing || []).map((m) => `• ${m}`).join('\n') || '• (some details)';
                const chase = (cfg.chaseTemplate || '').replace(/\[Name\]/g, t2.name).replace(/\[Missing\]/g, missingBlock);
                if (!t2.sentReplies) t2.sentReplies = [];
                t2.sentReplies.push({ text: chase, timestamp: now(), auto: true, kind: 'chase' });
                saveLeads(f2);
                if (jid) { try { await sock.sendMessage(jid, { text: chase }); } catch {} }
                console.log(`[wf] ${t2.name} signed INCOMPLETE (missing ${result.missing?.length || 0}) -> chased`);
              }
            }
          } catch (err) {
            console.error('[wf] signed-return processing failed:', err.message);
          }
        }
      } else if (target.stage === 'onboarding') {
        // Awaiting the lead's onboarding-session pick — AI parses their reply.
        const cfg = readConfig();
        const r = await parseOnboardingChoice(text, cfg.onboardingSessions);
        const f2 = readLeads();
        const t2 = f2.find((l) => l.id === target.id);
        if (t2 && r.sessionId) {
          const s = cfg.onboardingSessions.find((x) => x.id === r.sessionId);
          t2.stage = 'onboarding_slotted';
          t2.wf = { ...(t2.wf || {}), onboardingSession: r.sessionId, onboardingSlottedAt: now() };
          const confirm = `Great ${t2.name}, you're booked for ${s?.label}${s?.date ? ' on ' + s.date : ''}. See you there!`;
          if (!t2.sentReplies) t2.sentReplies = [];
          t2.sentReplies.push({ text: confirm, timestamp: now(), auto: true, kind: 'onboarding-confirm' });
          saveLeads(f2);
          const jid = toJid(t2.phone);
          if (jid) { try { await sock.sendMessage(jid, { text: confirm }); } catch {} }
          console.log(`[wf] ${t2.name} picked onboarding ${r.sessionId} -> onboarding_slotted`);
        } else {
          saveLeads(fresh); // unclear pick — leave for another reply / manual
        }
      } else if (target.stage && target.stage !== 'brief') {
        // Other stages — just keep the reply, no re-classification.
        saveLeads(fresh);
      } else {
        // Inbox stage: interest classification, auto-surfacing interested leads to 'brief'.
        const ai = await classifyReplies(target.name, target.replies);
        target.ai = { ...ai, classifiedAt: now() };
        if (ai.category === 'interested' && !target.stage) {
          target.stage = 'brief';
          target.wf = { ...(target.wf || {}), enteredAt: now() };
          console.log(`[pipeline] ${target.name} -> brief (interested)`);
        }
        saveLeads(fresh);
        console.log(`[ai] ${target.name}: ${ai.category} (${ai.confidence})`);

        // Auto-reply: if bot mode is ON, send the knowledge-grounded reply back.
        if (readConfig().autoReply && ai.suggested_reply && text !== '[media]') {
          const jid = toJid(target.phone);
          if (jid) {
            // small human-like delay before replying
            await new Promise((r) => setTimeout(r, 3000 + Math.floor(Math.random() * 4000)));
            try {
              await sock.sendMessage(jid, { text: ai.suggested_reply });
              const f2 = readLeads();
              const t2 = f2.find((l) => l.id === target.id);
              if (t2) {
                if (!t2.sentReplies) t2.sentReplies = [];
                t2.sentReplies.push({ text: ai.suggested_reply, timestamp: now(), auto: true });
                if (t2.ai) t2.ai.autoReplied = true;
                saveLeads(f2);
              }
              console.log(`[auto-reply] ${target.name}: ${ai.suggested_reply.slice(0, 50)}`);
            } catch (err) {
              console.error('[auto-reply] failed:', err.message);
            }
          }
        }
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
app.use(express.json({ limit: '15mb' })); // base64 document uploads

// Status + QR
app.get('/api/status', (_req, res) => {
  res.json({ state: connectionState, qr: currentQR, ai: !!anthropic, autoReply: readConfig().autoReply });
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

const PORT = process.env.PORT || 10001;
app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
