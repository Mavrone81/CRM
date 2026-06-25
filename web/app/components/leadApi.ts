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

// Send an outbound reply (Telegram sends directly; WhatsApp returns an error in manual mode).
export const sendReply = (id: number, text: string) => post(`/leads/${id}/send`, { text });

// Edit lead fields (name, phone, email, notes, adviser, assignedNumber…).
export async function updateLead(id: number, fields: Record<string, unknown>) {
  const r = await fetch(`${API}/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export { API };
