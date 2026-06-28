'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { Lead, WaStatus, Config, Session } from './types';
import type { Status } from './status';
import { PIPELINE_ORDER, STATUS_META } from './status';
import { sessionDisplay, relTime, lastContactOf, lastReplyOf } from './types';
import { fmtPhone } from './countryCodes';
import { API, setStatus, logReply, sendReply, sendAgreement, reclassify } from './leadApi';

// Tabs across the pipeline. Some statuses need a session pick to advance.
const TABS: { key: Status; hint: string }[] = [
  { key: 'interested', hint: 'You send the invite from your phone, then Mark invited' },
  { key: 'invited', hint: 'Awaiting their confirmation (bot auto-detects)' },
  { key: 'confirmed', hint: 'Assign a briefing session' },
  { key: 'scheduled', hint: 'Take attendance at the session' },
  { key: 'attended', hint: 'Send the agreement from your phone, then Mark sent' },
  { key: 'agreement', hint: 'Bot validates the returned signed PDF' },
  { key: 'signed', hint: 'Send onboarding options from your phone, then Mark sent' },
  { key: 'onboarding', hint: 'Assign an onboarding session (or bot auto-books on reply)' },
  { key: 'booked', hint: 'Take onboarding attendance' },
  { key: 'onboarded', hint: 'Sales Reps ✅' },
];

// next status for the primary "advance" button (those needing a session are handled inline).
// `contacts: true` means the action is us messaging them → record a last-contacted time.
const NEXT: Partial<Record<Status, { to: Status; label: string; contacts?: boolean }>> = {
  interested: { to: 'invited', label: 'Mark invite sent', contacts: true },
  invited: { to: 'confirmed', label: 'Mark confirmed' },
  scheduled: { to: 'attended', label: 'Mark attended' },
  attended: { to: 'agreement', label: 'Mark agreement sent', contacts: true },
  agreement: { to: 'signed', label: 'Mark signed' },
  signed: { to: 'onboarding', label: 'Mark onboarding offer sent', contacts: true },
  booked: { to: 'onboarded', label: 'Mark onboarded' },
};

export default function Pipeline({ leads, showToast, refresh }: { leads: Lead[]; status: WaStatus; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [active, setActive] = useState<Status>('interested');
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sendFor, setSendFor] = useState<number | null>(null);
  const [sendText, setSendText] = useState('');
  const [sort, setSort] = useState('contacted');
  const [suggesting, setSuggesting] = useState<number | null>(null);
  const [editText, setEditText] = useState<Record<number, string>>({}); // amended suggested replies (per lead)

  const loadConfig = useCallback(async () => { try { setConfig(await (await fetch(`${API}/config`)).json()); } catch {} }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  const mark = (id: number, on: boolean) => setBusy((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });
  const act = async (id: number, fn: () => Promise<{ ok: boolean; data: { ok?: boolean; error?: string } }>, msg: string) => {
    mark(id, true);
    try { const { ok, data } = await fn(); if (ok && data.ok !== false) { showToast(msg); refresh(); } else showToast(data.error || 'Failed', false); }
    catch { showToast('Network error', false); } finally { mark(id, false); }
  };
  const reclassifyLead = async (id: number, name: string) => {
    mark(id, true);
    try {
      const { ok, data } = await reclassify(id) as { ok: boolean; data: { moved?: boolean; from?: string; to?: string; reason?: string; error?: string } };
      if (ok) { showToast(data.moved ? `${name}: ${data.from} → ${data.to}` : `${name}: no change — ${data.reason || 'status looks right'}`); refresh(); }
      else showToast(data.error || 'Failed', false);
    } catch { showToast('Network error', false); } finally { mark(id, false); }
  };
  const suggest = async (id: number) => {
    setSuggesting(id);
    try {
      const r = await fetch(`${API}/leads/${id}/suggest`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.suggested_reply) { setEditText((p) => { const n = { ...p }; delete n[id]; return n; }); showToast('Regenerated'); refresh(); }
      else showToast(d.error || 'Could not regenerate', false);
    } catch { showToast('Network error', false); } finally { setSuggesting(null); }
  };

  const byStatus: Record<string, Lead[]> = {};
  PIPELINE_ORDER.forEach((s) => (byStatus[s] = []));
  leads.forEach((l) => { if (l.status && byStatus[l.status]) byStatus[l.status].push(l); });

  const ts = (s: string | null) => (s ? new Date(s).getTime() : 0);
  const sortLeads = (list: Lead[]) => {
    const a = [...list];
    // New replies always float to the top, then the chosen sort within each group.
    const nr = (x: Lead, y: Lead) => Number(!!y.needsReply) - Number(!!x.needsReply);
    if (sort === 'name') a.sort((x, y) => nr(x, y) || x.name.localeCompare(y.name));
    else if (sort === 'reply') a.sort((x, y) => nr(x, y) || (ts(lastReplyOf(y)) - ts(lastReplyOf(x))));
    else if (sort === 'needs') a.sort((x, y) => nr(x, y) || (ts(lastReplyOf(y)) - ts(lastReplyOf(x))));
    else a.sort((x, y) => nr(x, y) || (ts(lastContactOf(x)) - ts(lastContactOf(y)))); // coldest / never-contacted first
    return a;
  };

  const sessionCount = (id: string) => leads.filter((l) => l.wf?.session === id && PIPELINE_ORDER.indexOf(l.status as Status) >= PIPELINE_ORDER.indexOf('scheduled')).length;
  const sessionLabelOf = (id?: string | null) => { const s = config?.sessions.find((x) => x.id === id); return s ? sessionDisplay(s) : id || '—'; };

  const card = (l: Lead) => {
    const lr = l.replies?.[l.replies.length - 1];
    const next = NEXT[l.status as Status];
    const b = busy.has(l.id);
    return (
      <div key={l.id} className="rounded-xl border border-gray-700 bg-gray-900/50 p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-100 text-sm">{l.name}</span>
          <span className="text-xs text-gray-500 font-mono">{fmtPhone(l.phone)}</span>
          {l.channel === 'telegram' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-950 border border-sky-800 text-sky-300">✈ TG</span>}
          {l.needsReply && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900 border border-blue-700 text-blue-200">new reply</span>}
        </div>
        {lr && <p className="text-xs text-gray-400 bg-gray-800/60 rounded-lg px-2 py-1.5 line-clamp-2">“{lr.text}”</p>}
        <div className="flex gap-3 text-[11px] text-gray-500">
          <span>Contacted: <span className="text-gray-400">{relTime(lastContactOf(l)) || 'never'}</span></span>
          {lastReplyOf(l) && <span>Replied: <span className="text-gray-400">{relTime(lastReplyOf(l))}</span></span>}
        </div>

        {/* AI-recommended reply / invite — editable, then Regenerate (✨), Send (via the lead's number), or Copy */}
        {l.ai?.suggested_reply ? (() => {
          const val = editText[l.id] ?? l.ai.suggested_reply;
          return (
          <div className="flex flex-col gap-1.5 bg-gray-950/60 border border-gray-800 rounded-lg p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-purple-300">Suggested reply <span className="text-gray-600">· editable</span></span>
              <button onClick={() => suggest(l.id)} disabled={suggesting === l.id} title="Regenerate suggestion" className="text-[11px] text-purple-300 hover:text-purple-200 whitespace-nowrap disabled:opacity-50">{suggesting === l.id ? '…' : '✨ Regenerate'}</button>
            </div>
            <textarea value={val} onChange={(e) => setEditText((p) => ({ ...p, [l.id]: e.target.value }))} rows={3} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-green-600" />
            <div className="flex gap-2">
              <button onClick={() => act(l.id, () => sendReply(l.id, val), `Sent to ${l.name}`)} disabled={b || !val.trim()} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg">{b ? '…' : 'Send'}</button>
              <button onClick={() => { navigator.clipboard.writeText(val); showToast('Copied'); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Copy</button>
            </div>
          </div>
          );
        })() : (
          <button onClick={() => suggest(l.id)} disabled={suggesting === l.id} className="self-start text-xs text-purple-300 hover:text-purple-200 border border-purple-900/50 rounded-lg px-2.5 py-1 disabled:opacity-50">{suggesting === l.id ? 'Generating…' : '✨ Suggest a reply'}</button>
        )}

        {/* Agreement / signed: validation result + download the stored signed PDF */}
        {(l.status === 'agreement' || l.status === 'signed') && l.wf?.signed && (() => { const r = l.wf.signed.result; return (
          <div className={`text-xs rounded-lg px-2 py-1.5 border ${r?.complete || l.status === 'signed' ? 'border-green-700 bg-green-950/30 text-green-300' : 'border-amber-800 bg-amber-950/20 text-amber-300'}`}>
            {l.status === 'signed' ? '✓ Signed' : r?.complete ? '✓ Signed & complete' : `⚠ Incomplete — missing ${r?.missing?.length ?? 0}`}
            {l.status !== 'signed' && !r?.complete && r?.missing?.length ? <span className="block text-gray-400 mt-0.5">{r.missing.join(', ')}</span> : null}
            {l.wf.signed.lastFile ? <a href={`${API}/leads/${l.id}/signed`} target="_blank" rel="noopener noreferrer" className="block mt-1 text-cyan-300 hover:text-cyan-200 underline">📄 Download signed agreement</a> : null}
          </div>
        ); })()}

        {(l.status === 'scheduled' || l.status === 'booked') && (
          <span className="text-xs text-gray-300">Session: <span className="text-cyan-300">{sessionLabelOf(l.wf?.session)}</span></span>
        )}

        {/* Session assignment for confirmed -> scheduled, onboarding -> booked */}
        {(l.status === 'confirmed' || l.status === 'onboarding') && (
          <select defaultValue="" disabled={b}
            onChange={(e) => e.target.value && act(l.id, () => setStatus(l.id, l.status === 'confirmed' ? 'scheduled' : 'booked', { session: e.target.value }), `${l.name} booked`)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-green-600">
            <option value="" disabled>Assign session…</option>
            {(config?.sessions || []).map((s) => <option key={s.id} value={s.id}>{sessionDisplay(s)} ({sessionCount(s.id)}/{s.capacity})</option>)}
          </select>
        )}

        <div className="flex gap-2 flex-wrap">
          {l.status === 'attended' && <button onClick={() => act(l.id, () => sendAgreement(l.id), `📎 Agreement (PDF) sent to ${l.name}`)} disabled={b} title="Sends the agreement PDF via this lead's number and moves them to Agreement"
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg">{b ? '…' : '📎 Send agreement'}</button>}
          {next && <button onClick={() => act(l.id, () => setStatus(l.id, next.to, next.contacts ? { contacted: true } : undefined), `${l.name}: ${next.label}`)} disabled={b}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg">{b ? '…' : next.label}</button>}
          {l.channel === 'telegram' && <button onClick={() => { setSendFor(sendFor === l.id ? null : l.id); setSendText(l.ai?.suggested_reply || ''); }} className="text-xs text-sky-400 hover:text-sky-300 px-2 py-1.5 font-medium">Reply ✈</button>}
          <button onClick={() => { setReplyFor(replyFor === l.id ? null : l.id); setReplyText(''); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Log reply</button>
          <button onClick={() => reclassifyLead(l.id, l.name)} disabled={b} title="Ask the bot to re-read the chat and update the stage" className="text-xs text-purple-300 hover:text-purple-200 px-2 py-1.5 disabled:opacity-50">🔄 Re-classify</button>
          <select value="" onChange={(e) => { if (e.target.value) act(l.id, () => setStatus(l.id, e.target.value as Status), `Moved ${l.name}`); }}
            className="text-[11px] text-gray-500 bg-transparent border-0 focus:outline-none cursor-pointer ml-auto">
            <option value="">Move ▾</option>
            {(['declined', 'opted_out', ...PIPELINE_ORDER] as Status[]).filter((s) => s !== l.status).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </div>

        {replyFor === l.id && (
          <div className="flex gap-2">
            <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="What they said…" autoFocus
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-green-600" />
            <button onClick={() => replyText.trim() && act(l.id, () => logReply(l.id, replyText.trim()), 'Reply logged').then(() => setReplyFor(null))}
              className="bg-blue-700 hover:bg-blue-600 text-white text-xs px-2.5 py-1.5 rounded-lg">Save</button>
          </div>
        )}

        {sendFor === l.id && (
          <div className="flex gap-2">
            <input value={sendText} onChange={(e) => setSendText(e.target.value)} placeholder="Reply via Telegram…" autoFocus
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-green-600" />
            <button onClick={() => sendText.trim() && act(l.id, () => sendReply(l.id, sendText.trim()), `Sent to ${l.name}`).then(() => setSendFor(null))}
              className="bg-green-700 hover:bg-green-600 text-white text-xs px-2.5 py-1.5 rounded-lg">Send</button>
          </div>
        )}
      </div>
    );
  };

  const activeTab = TABS.find((t) => t.key === active);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 py-3 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <h2 className="text-base sm:text-lg font-semibold text-gray-100">Recruitment Pipeline</h2>
        <span className="text-xs text-gray-500">{PIPELINE_ORDER.reduce((n, s) => n + byStatus[s].length, 0)} in pipeline</span>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="ml-auto text-xs bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-green-600">
          <option value="contacted">Sort: Coldest contact first</option>
          <option value="reply">Sort: Newest reply first</option>
          <option value="needs">Sort: Needs reply first</option>
          <option value="name">Sort: Name A–Z</option>
        </select>
      </div>
      <div className="px-4 sm:px-6 border-b border-gray-800 flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const on = active === t.key;
          return (
            <button key={t.key} onClick={() => setActive(t.key)}
              className={`px-3 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px inline-flex items-center gap-1.5 ${on ? 'border-green-500 text-green-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
              {STATUS_META[t.key].label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${on ? 'bg-green-900 text-green-200' : 'bg-gray-800 text-gray-500'}`}>{byStatus[t.key].length}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <p className="text-xs text-gray-500 mb-4">{activeTab?.hint}</p>
        {byStatus[active].length === 0 ? (
          <div className="text-sm text-gray-700 text-center py-16 border border-dashed border-gray-800 rounded-xl">No leads in {STATUS_META[active].label}.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">{sortLeads(byStatus[active]).map(card)}</div>
        )}
      </div>
    </div>
  );
}
