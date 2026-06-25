'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { Lead, WaStatus, Config, Session } from './types';
import type { Status } from './status';
import { PIPELINE_ORDER, STATUS_META } from './status';
import { sessionDisplay, relTime, lastContactOf, lastReplyOf } from './types';
import { API, setStatus, logReply, sendReply } from './leadApi';

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

  const loadConfig = useCallback(async () => { try { setConfig(await (await fetch(`${API}/config`)).json()); } catch {} }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  const mark = (id: number, on: boolean) => setBusy((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });
  const act = async (id: number, fn: () => Promise<{ ok: boolean; data: { ok?: boolean; error?: string } }>, msg: string) => {
    mark(id, true);
    try { const { ok, data } = await fn(); if (ok && data.ok !== false) { showToast(msg); refresh(); } else showToast(data.error || 'Failed', false); }
    catch { showToast('Network error', false); } finally { mark(id, false); }
  };

  const byStatus: Record<string, Lead[]> = {};
  PIPELINE_ORDER.forEach((s) => (byStatus[s] = []));
  leads.forEach((l) => { if (l.status && byStatus[l.status]) byStatus[l.status].push(l); });

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
          <span className="text-xs text-gray-500 font-mono">{l.phone}</span>
          {l.channel === 'telegram' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-950 border border-sky-800 text-sky-300">✈ TG</span>}
          {l.needsReply && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900 border border-blue-700 text-blue-200">new reply</span>}
        </div>
        {lr && <p className="text-xs text-gray-400 bg-gray-800/60 rounded-lg px-2 py-1.5 line-clamp-2">“{lr.text}”</p>}
        <div className="flex gap-3 text-[11px] text-gray-500">
          <span>Contacted: <span className="text-gray-400">{relTime(lastContactOf(l)) || 'never'}</span></span>
          {lastReplyOf(l) && <span>Replied: <span className="text-gray-400">{relTime(lastReplyOf(l))}</span></span>}
        </div>

        {/* AI-recommended reply / invite — Send (Telegram) or Copy (send from phone) */}
        {l.ai?.suggested_reply && (
          <div className="text-xs bg-gray-950/60 border border-gray-800 rounded-lg p-2 flex items-start gap-2">
            <span className="text-purple-300 whitespace-nowrap">Suggested:</span>
            <span className="text-gray-300 flex-1">{l.ai.suggested_reply}</span>
            {l.channel === 'telegram' && <button onClick={() => act(l.id, () => sendReply(l.id, l.ai!.suggested_reply), `Sent to ${l.name}`)} disabled={b} className="text-green-400 hover:text-green-300 whitespace-nowrap font-medium">Send</button>}
            <button onClick={() => { navigator.clipboard.writeText(l.ai!.suggested_reply); showToast('Copied'); }} className="text-gray-400 hover:text-gray-200 whitespace-nowrap">Copy</button>
          </div>
        )}

        {/* Agreement: show signed-validation result */}
        {l.status === 'agreement' && l.wf?.signed && (() => { const r = l.wf.signed.result; return (
          <div className={`text-xs rounded-lg px-2 py-1.5 border ${r?.complete ? 'border-green-700 bg-green-950/30 text-green-300' : 'border-amber-800 bg-amber-950/20 text-amber-300'}`}>
            {r?.complete ? '✓ Signed & complete' : `⚠ Incomplete — missing ${r?.missing?.length ?? 0}`}
            {!r?.complete && r?.missing?.length ? <span className="block text-gray-400 mt-0.5">{r.missing.join(', ')}</span> : null}
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
          {next && <button onClick={() => act(l.id, () => setStatus(l.id, next.to, next.contacts ? { contacted: true } : undefined), `${l.name}: ${next.label}`)} disabled={b}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg">{b ? '…' : next.label}</button>}
          {l.channel === 'telegram' && <button onClick={() => { setSendFor(sendFor === l.id ? null : l.id); setSendText(l.ai?.suggested_reply || ''); }} className="text-xs text-sky-400 hover:text-sky-300 px-2 py-1.5 font-medium">Reply ✈</button>}
          <button onClick={() => { setReplyFor(replyFor === l.id ? null : l.id); setReplyText(''); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Log reply</button>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">{byStatus[active].map(card)}</div>
        )}
      </div>
    </div>
  );
}
