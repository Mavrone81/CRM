// Shared lead-action helpers — every view changes a lead through these (one path).
import type { Status } from './status';

const API = '/api/proxy';

async function post(path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

// The ONE canonical transition. opts.session attaches a session; opts.contacted
// records a "last contacted" timestamp (used by the manual "Mark … sent" actions).
export const setStatus = (id: number, status: Status, opts?: { session?: string | null; contacted?: boolean }) =>
  post(`/leads/${id}/status`, { status, ...opts });

// Clear the "new reply" flag without changing status.
export const ackLead = (id: number) => post(`/leads/${id}/ack`);

// Manually log an inbound reply the bot missed (auto-classifies if pre-pipeline).
export const logReply = (id: number, text: string) => post(`/leads/${id}/reply`, { text });

// WhatsApp is Baileys-free: the rep sends from their own app via a click-to-chat
// deep link (opens WhatsApp with the message pre-filled). We only RECORD the send.
// waLink builds the link; logSent records it in the CRM thread + bumps last-contacted.
export function waLink(phone: string, text: string) {
  const digits = (phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
export const logSent = (id: number, text: string, opts?: { kind?: string }) =>
  post(`/leads/${id}/log-sent`, { text, ...opts });

// Direct download URL for a stored document (default = the default agreement) so a
// rep can attach it manually in WhatsApp — deep links can't carry a file.
export const docDownloadUrl = (docId = 'default') => `${API}/documents/${docId}/download`;

// Send an outbound reply. If the number is at its daily cap, the server returns
// cap_exceeded (409) — we prompt the user to confirm before breaching it (anti-ban).
export async function sendReply(id: number, text: string, force = false) {
  const r = await post(`/leads/${id}/send`, { text, force });
  if (force || r.ok || (r.data as { error?: string })?.error !== 'cap_exceeded') return r;
  const d = r.data as { label?: string; sentToday?: number; cap?: number };
  const proceed = typeof window !== 'undefined' && window.confirm(`⚠️ ${d.label || 'This number'} has hit its daily cap (${d.sentToday}/${d.cap}).\n\nSending more raises the risk of a WhatsApp ban. Send anyway?`);
  if (!proceed) return { ok: false, data: { error: 'Daily cap reached — not sent' } };
  return post(`/leads/${id}/send`, { text, force: true });
}

// Send the associate agreement — the PDF document (not just text) via the lead's
// own number, and advance status to 'agreement'. Use this for the attended→agreement
// step so the attachment actually goes out.
export const sendAgreement = (id: number) => post(`/wf/agreement/${id}`);

// Ask the bot to re-read the conversation and move the lead to the best-fit stage
// (forward-only, gated stages protected). Returns { from, to, moved, reason }.
export const reclassify = (id: number) => post(`/leads/${id}/reclassify`);

// Edit lead fields (name, phone, email, notes, adviser, assignedNumber…).
export async function updateLead(id: number, fields: Record<string, unknown>) {
  const r = await fetch(`${API}/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export { API };
