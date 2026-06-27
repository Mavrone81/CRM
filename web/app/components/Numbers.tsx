'use client';

import React, { useState } from 'react';
import type { WaNumber, Outreach } from './types';
import { relTime } from './types';
import { fmtPhone } from './countryCodes';

const API = '/api/proxy';

const STATE_CHIP: Record<string, string> = {
  open: 'bg-green-950 border-green-700 text-green-300',
  connecting: 'bg-yellow-950 border-yellow-700 text-yellow-300',
  banned: 'bg-red-950 border-red-800 text-red-300',
  close: 'bg-gray-900 border-gray-700 text-gray-400',
};
const STATE_LABEL: Record<string, string> = { open: 'Connected', connecting: 'Scan QR', banned: 'Blocked', close: 'Disconnected' };

export default function Numbers({ numbers, outreach, newLeadCount = 0, onClose, showToast, refresh }: { numbers: WaNumber[]; outreach?: Outreach; newLeadCount?: number; onClose: () => void; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  // Combined remaining sends across connected numbers for today.
  const remainingCap = numbers.filter((n) => n.state === 'open').reduce((s, n) => s + Math.max(0, (n.cap || 40) - (n.sentToday || 0)), 0);

  const add = async () => {
    setBusy(true);
    try { const r = await fetch(`${API}/numbers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok) { showToast('Number added — scan its QR'); refresh(); } else showToast('Max 10 numbers, or failed', false); }
    catch { showToast('Network error', false); } finally { setBusy(false); }
  };
  const relink = async (id: string) => { await fetch(`${API}/numbers/${id}/relink`, { method: 'POST' }); showToast('Generating QR…'); refresh(); };
  const pause = async (id: string, paused: boolean) => { await fetch(`${API}/numbers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) }); showToast(paused ? 'Paused — kept out of outreach, still tested every 6h' : 'Resumed'); refresh(); };
  const testNow = async (id: string) => { const r = await fetch(`${API}/numbers/${id}/probe`, { method: 'POST' }); const d = await r.json().catch(() => ({})); if (r.ok) showToast(`Probe sent to ${d.to || 'control'} — watch for ✓✓`); else showToast(d.error || 'Probe failed', false); refresh(); };
  const remove = async (id: string) => { if (!confirm('Remove this number? Its session is cleared.')) return; await fetch(`${API}/numbers/${id}`, { method: 'DELETE' }); showToast('Removed'); refresh(); };
  // No refresh() here: these run on input blur, and a refresh re-render during the
  // close-click was swallowing the ✕ (modal wouldn't close). The value is already
  // persisted server-side and the dashboard polls status every 2.5s.
  const setCap = async (id: string, dailyCap: number) => { await fetch(`${API}/numbers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyCap }) }); showToast(`Daily cap set to ${dailyCap}`); };
  const setRepName = async (id: string, repName: string) => { await fetch(`${API}/numbers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repName }) }); showToast(repName ? `Rep name set to ${repName}` : 'Rep name cleared'); };
  const startOutreach = async () => {
    const over = newLeadCount > remainingCap;
    const msg = `Start paced outreach to ${newLeadCount} New lead(s)?\n\n` +
      (over
        ? `⚠ Only ${remainingCap} can go out today (combined remaining cap across your connected numbers). The other ${newLeadCount - remainingCap} will wait until caps reset tomorrow or you raise them.\n\n`
        : `Within today's capacity — ${remainingCap} sends remaining across your numbers.\n\n`) +
      'A varied opening is sent to each, ~20–50s apart. You can stop anytime.';
    if (!confirm(msg)) return;
    const r = await fetch(`${API}/outreach/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) showToast(`Outreach started — ${d.queued} queued`); else showToast(d.error || 'Failed', false);
    refresh();
  };
  const stopOutreach = async () => { const r = await fetch(`${API}/outreach/stop`, { method: 'POST' }); const d = await r.json().catch(() => ({})); showToast(`Stopped — ${d.cleared || 0} unsent`); refresh(); };
  const distribute = async () => {
    if (!confirm('Assign only the UNASSIGNED leads evenly across the connected numbers? Leads already tagged to an agent keep their agent (sticky) — they are never moved.')) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/numbers/distribute`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { showToast(`Assigned ${d.total} unassigned${d.kept ? `, kept ${d.kept} tagged` : ''} — ${(d.numbers || []).map((n: { label: string; count: number }) => `${n.label}: ${n.count}`).join(', ')}`); refresh(); }
      else showToast(d.error || 'Failed', false);
    } catch { showToast('Network error', false); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">WhatsApp numbers</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200">✕</button>
        </div>
        <div className="p-4 overflow-auto flex flex-col gap-4">
          {numbers.map((n) => (
            <div key={n.id} className="border border-gray-800 rounded-xl p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-gray-200">{n.label}</span>
                {n.phone && <span className="text-xs text-gray-400 font-mono">{fmtPhone(n.phone)}</span>}
                <span className={`text-xs px-2 py-0.5 rounded-full border ${STATE_CHIP[n.state] || STATE_CHIP.close}`}>{STATE_LABEL[n.state] || n.state}</span>
                {n.health === 'undelivered' && <span className="text-xs px-2 py-0.5 rounded-full border bg-red-950 border-red-800 text-red-300" title="Sends aren't being delivered — likely shadow-limited. Excluded from outreach.">⚠ not delivering</span>}
                {n.paused && <span className="text-xs px-2 py-0.5 rounded-full border bg-gray-800 border-gray-600 text-gray-300">⏸ paused</span>}
                <div className="ml-auto flex gap-2">
                  <button onClick={() => testNow(n.id)} className="text-xs text-sky-400 hover:text-sky-300">Test</button>
                  <button onClick={() => pause(n.id, !n.paused)} className="text-xs text-gray-400 hover:text-gray-200">{n.paused ? 'Resume' : 'Pause'}</button>
                  <button onClick={() => relink(n.id)} className="text-xs text-gray-400 hover:text-gray-200">Relink</button>
                  {numbers.length > 1 && <button onClick={() => remove(n.id)} className="text-xs text-gray-500 hover:text-red-400">Remove</button>}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <span className="whitespace-nowrap">Rep name</span>
                <input type="text" defaultValue={n.repName || ''} placeholder="e.g. Vivian — leads see this name" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (n.repName || '')) setRepName(n.id, v); }} className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-green-600" />
              </label>
              {n.probe && (
                <div className="text-[11px] text-gray-500">
                  Delivery check {relTime(new Date(n.probe.at).toISOString())}:{' '}
                  {n.probe.delivered ? <span className="text-green-400">✅ delivered — number is working</span>
                    : n.probe.error ? <span className="text-red-400">❌ {n.probe.error}</span>
                    : <span className="text-amber-400">⏳ sent, awaiting ✓✓…</span>}
                </div>
              )}
              {n.state === 'open' && (
                <div className="flex items-center gap-2 text-xs">
                  <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden"><div className={`h-full ${(n.sentToday || 0) >= (n.cap || 40) ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, Math.round(((n.sentToday || 0) / (n.cap || 40)) * 100))}%` }} /></div>
                  <span className="text-gray-400 tabular-nums whitespace-nowrap">{n.sentToday || 0}/{n.cap || 40} today{(n.cap || 40) < (n.dailyCap || 40) ? ' (warming)' : ''}</span>
                  <label className="text-gray-500 flex items-center gap-1 whitespace-nowrap">cap <input type="number" min={1} defaultValue={n.dailyCap || 40} onBlur={(e) => setCap(n.id, Number(e.target.value))} className="w-12 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-gray-200 focus:outline-none focus:border-green-600" /></label>
                </div>
              )}
              {n.state !== 'open' && (n.qr
                ? <img src={n.qr} alt="QR" className="w-48 h-48 rounded-lg bg-white p-1 self-center" />
                : <button onClick={() => relink(n.id)} className="self-start text-sm bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg">Generate QR</button>)}
            </div>
          ))}
          <button onClick={add} disabled={busy} className="text-sm text-gray-300 hover:text-white border border-dashed border-gray-700 rounded-lg py-2 disabled:opacity-50">+ Add a number</button>
          <button onClick={distribute} disabled={busy} className="text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 text-gray-200 font-medium rounded-lg py-2">Distribute leads evenly across numbers</button>
          <p className="text-[11px] text-gray-600">Distribute splits every lead still needing contact almost-equally and at random across the connected numbers. Each lead then sticks to its number.</p>

          <div className="border-t border-gray-800 pt-3 mt-1 flex flex-col gap-2">
            <div className="flex items-center justify-between"><span className="text-sm font-medium text-gray-200">Outreach</span>{outreach?.running && (outreach.windowOpen === false ? <span className="text-xs text-amber-400">⏸ quiet hours</span> : <span className="text-xs text-green-400 animate-pulse">● running</span>)}</div>
            {outreach?.running ? (
              <>
                <div className="text-xs text-gray-400 tabular-nums">Sent {outreach.sent} · {outreach.queued} queued{outreach.failed ? ` · ${outreach.failed} failed` : ''}</div>
                {outreach.windowOpen === false && <div className="text-[11px] text-amber-400/90">Paused — outside the send window (7am–10:30pm SGT). Resumes automatically.</div>}
                <button onClick={stopOutreach} className="text-sm bg-red-700 hover:bg-red-600 text-white rounded-lg py-2">Stop outreach</button>
              </>
            ) : (
              <>
                <div className="text-xs text-gray-400 tabular-nums">{newLeadCount} New leads · {remainingCap} sends left today{newLeadCount > remainingCap ? <span className="text-amber-400"> · {newLeadCount - remainingCap} over today&apos;s cap</span> : null}</div>
                <button onClick={startOutreach} disabled={newLeadCount === 0 || remainingCap === 0} className="text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white font-medium rounded-lg py-2.5">Start outreach to all New leads</button>
              </>
            )}
            <p className="text-[11px] text-gray-600">Sends a varied (spintax) opening to each New lead, paced ~20–50s apart across your numbers, only during 7am–10:30pm SGT, never exceeding a number&apos;s daily cap. Auto-skips capped/blocked numbers and anyone who opted out.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
