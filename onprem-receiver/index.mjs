// Watapp — on-prem read-only WhatsApp receiver.
//
// WhatsApp 428-blocks Baileys from the CRM's datacenter IP, but connects fine from a
// residential IP. This tiny listener runs on the on-prem (residential) box, links as
// a read-only device, and forwards every incoming message — and the rep's own sends —
// to the CRM's /api/ingest. It NEVER sends a WhatsApp message, so it carries no ban
// risk from sending; outbound stays click-to-chat deep links in the CRM.
//
// Config (env): INGEST_TOKEN (required, must match the CRM server's), CRM_INGEST_URL
// (default the prod proxy path), NUMBER_ID (the CRM number id this line maps to, e.g.
// 'onprem-n2'), SESSION_DIR (default ./session). Link once by scanning the QR.
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import qrpng from 'qrcode';

const INGEST_URL = process.env.CRM_INGEST_URL || 'https://crm.urbanwerkzsg.com/api/proxy/ingest';
const TOKEN = process.env.INGEST_TOKEN || '';
const NUMBER_ID = process.env.NUMBER_ID || 'onprem';
const SESSION_DIR = process.env.SESSION_DIR || './session';
// If set, link by PAIRING CODE (type a code on the phone) instead of scanning a QR —
// far easier for a remote/headless box. Must be the full number in E.164, digits only.
const PAIR_PHONE = (process.env.PAIR_PHONE || '').replace(/\D/g, '');

if (!TOKEN) { console.error('FATAL: INGEST_TOKEN is required (must match the CRM server).'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Pull the real phone number from whichever JID carries it (@lid chats route via a
// non-phone id; the phone lives on an alt/PN field).
function phoneOf(key = {}) {
  const jids = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt, key.senderPn].filter(Boolean);
  const pj = jids.find((j) => j.includes('@s.whatsapp.net'));
  return pj ? pj.replace('@s.whatsapp.net', '').replace(/\D/g, '') : '';
}

function textOf(message = {}) {
  const doc = message.documentMessage || message.documentWithCaptionMessage?.message?.documentMessage;
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || (doc ? '' : '');
}

// POST a batch of normalised messages to the CRM, with a couple of retries.
async function forward(messages) {
  if (!messages.length) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, messages }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { log(`→ CRM: synced=${body.synced} matched=${body.matched} unmatched=${body.unmatched}`); return; }
      log(`→ CRM error HTTP ${res.status}`, body.error || '');
      if (res.status === 401) return; // bad token — retrying won't help
    } catch (e) { log(`→ CRM POST failed (attempt ${attempt}): ${e.message}`); }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try { ({ version } = await fetchLatestWaWebVersion({})); }
  catch { ({ version } = await fetchLatestBaileysVersion()); }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false, // stay passive — we only listen
    syncFullHistory: false,     // only new messages; the CRM already has the thread
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing-code linking (no QR): request a code once, for a fresh (unregistered) session.
  if (PAIR_PHONE && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIR_PHONE);
        console.log(`\n>>> PAIRING CODE: ${code}`);
        console.log(`>>> On the ${NUMBER_ID} phone: WhatsApp → Settings → Linked Devices → Link a device → "Link with phone number instead" → enter this code.\n`);
      } catch (e) { console.log(`pairing-code request failed: ${e.message}`); }
    }, 3000);
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !PAIR_PHONE) {
      console.log(`\nScan this QR with WhatsApp on the ${NUMBER_ID} phone (Linked Devices → Link a device):\n`);
      qrcode.generate(qr, { small: true });
      // Also write a scannable PNG so it can be delivered off-box (the ASCII QR is
      // hard to scan remotely). Overwritten on each rotation — grab the freshest.
      try { await qrpng.toFile(`${SESSION_DIR}/latest-qr.png`, qr, { width: 512, margin: 2 }); console.log('QR PNG → session/latest-qr.png'); } catch (e) { console.log(`QR PNG failed: ${e.message}`); }
    }
    if (connection === 'open') log(`✓ linked & listening (read-only) as ${NUMBER_ID}`);
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { log('✗ logged out — delete the session dir and re-link.'); process.exit(1); }
      log(`connection closed (code ${code}) — reconnecting in 10s…`);
      setTimeout(connect, 10000); // gentle reconnect (no hammering)
    }
  });

  // The one job: forward inbound + our own sends. NEVER send.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // only live messages, not history/append
    const out = [];
    for (const msg of messages) {
      if (!msg.message) continue;
      const phone = phoneOf(msg.key);
      if (!phone) continue; // @lid-only with no resolvable phone — skip
      let text = textOf(msg.message);
      const doc = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
      const payload = {
        phone,
        text,
        fromMe: !!msg.key.fromMe,
        id: msg.key.id || undefined,
        ts: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : undefined,
        via: NUMBER_ID,
      };
      // A returned PDF (signed agreement) — download the bytes so the CRM can validate.
      if (!msg.key.fromMe && doc && (doc.mimetype || '').toLowerCase().includes('pdf')) {
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          payload.pdfBase64 = buf.toString('base64');
          payload.fileName = doc.fileName || 'agreement.pdf';
        } catch (e) { log(`PDF download failed: ${e.message}`); }
      }
      if (!payload.text && !payload.pdfBase64) continue; // nothing useful to sync
      out.push(payload);
    }
    await forward(out);
  });
}

log(`starting receiver → ${INGEST_URL} (number ${NUMBER_ID})`);
connect().catch((e) => { console.error('fatal:', e); process.exit(1); });
