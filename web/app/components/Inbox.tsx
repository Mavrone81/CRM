'use client';

import React, { useState } from 'react';
import type { Lead } from './types';
import { relTime } from './types';
import { logReply, sendReply, setStatus } from './leadApi';

// Triage queue: leads that replied and need a human decision (question / review).
export default function Inbox({ leads, showToast, refresh }: { leads: Lead[]; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [composeFor, setComposeFor] = useState<number | null>(null);
  const [composeText, setComposeText] = useState('');
  const [suggesting, setSuggesting] = useState<number | null>(null);

  const suggest = async (id: number) => {
    setSuggesting(id);
    try {
      const r = await fetch(`/api/proxy/leads/${id}/suggest`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.suggested_reply) { setComposeFor(id); setComposeText(d.suggested_reply); refresh(); }
      else showToast(d.error || 'Could not generate a suggestion', false);
    } catch { showToast('Network error', false); } finally { setSuggesting(null); }
  };

  const queue = leads
    .filter((l) => l.status === 'question' || l.status === 'review' || l.status === 'new')
    .sort((a, b) => Number(b.needsReply) - Number(a.needsReply));

  const mark = (id: number, on: boolean) => setBusy((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });
  const act = async (id: number, fn: () => Promise<{ ok: boolean; data: { ok?: boolean; error?: string } }>, msg: string) => {
    mark(id, true);
    try { const { ok, data } = await fn(); if (ok && data.ok !== false) { showToast(msg); refresh(); } else showToast(data.error || 'Failed', false); }
    catch { showToast('Network error', false); } finally { mark(id, false); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <h2 className="text-base sm:text-lg font-semibold text-gray-100">Action Inbox</h2>
        <span className="text-xs sm:text-sm text-gray-500">{queue.length} need a decision</span>
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6 flex flex-col gap-3">
        {queue.length === 0 && <div className="text-center text-gray-600 py-16">Nothing to triage — all replies have been actioned. 🎉</div>}
        {queue.map((l) => {
          const thread = [
            ...(l.replies || []).map((r) => ({ text: r.text, ts: r.timestamp, dir: 'in' as const, auto: false })),
            ...(l.sentReplies || []).map((r) => ({ text: r.text, ts: r.timestamp, dir: 'out' as const, auto: !!r.auto })),
          ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
          const b = busy.has(l.id);
          return (
            <div key={l.id} className={`rounded-xl border p-4 flex flex-col gap-2 ${l.status === 'question' ? 'border-yellow-800/50 bg-yellow-950/10' : l.status === 'new' ? 'border-gray-700 bg-gray-900/40' : 'border-orange-800/40 bg-orange-950/10'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-gray-100">{l.name}</span>
                <span className="text-xs text-gray-500 font-mono">{l.phone}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${l.status === 'question' ? 'bg-yellow-900 text-yellow-300' : l.status === 'new' ? 'bg-gray-800 text-gray-300' : 'bg-orange-900/60 text-orange-300'}`}>{l.status === 'question' ? '? Question' : l.status === 'new' ? 'New — to contact' : 'Needs review'}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${l.channel === 'telegram' ? 'bg-sky-950 border-sky-800 text-sky-300' : 'bg-green-950 border-green-800 text-green-300'}`}>{l.channel === 'telegram' ? '✈ Telegram' : 'WhatsApp'}</span>
                {l.needsReply && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900 border border-blue-700 text-blue-200">new</span>}
              </div>
              {thread.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-64 overflow-auto py-1">
                  {thread.map((m, i) => (
                    <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ${m.dir === 'out' ? 'self-end bg-green-900/40 text-green-50 rounded-br-sm' : 'self-start bg-gray-800 text-gray-200 rounded-bl-sm'}`}>
                      {m.text}
                      <span className="block text-[10px] text-gray-500 mt-0.5">{m.dir === 'out' ? (m.auto ? 'sent · bot' : 'you') : 'them'} · {relTime(m.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
              {l.ai?.reason && <p className="text-xs text-gray-400 italic">{l.ai.reason}</p>}
              {(l.ai?.suggested_reply || composeFor === l.id) ? (
                <div className="flex flex-col gap-1.5 bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-purple-300">Suggested reply <span className="text-gray-600">· {l.channel === 'telegram' ? 'Telegram' : 'WhatsApp'}</span></span>
                    <button onClick={() => suggest(l.id)} disabled={suggesting === l.id} className="text-[11px] text-gray-400 hover:text-gray-200">{suggesting === l.id ? '…' : '✨ Regenerate'}</button>
                  </div>
                  <textarea value={composeFor === l.id ? composeText : (l.ai?.suggested_reply || '')} onChange={(e) => { setComposeFor(l.id); setComposeText(e.target.value); }} rows={3} placeholder="Type a reply, or ✨ Regenerate for an AI draft…" className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-green-600" />
                  <div className="flex gap-2">
                    <button onClick={() => act(l.id, () => sendReply(l.id, composeFor === l.id ? composeText : l.ai!.suggested_reply), `Sent to ${l.name}`).then(() => { setComposeFor(l.id); setComposeText(''); })} disabled={b || !((composeFor === l.id ? composeText : l.ai?.suggested_reply) || '').trim()} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg">{b ? '…' : `Send ${l.channel === 'telegram' ? '✈' : 'via WhatsApp'}`}</button>
                    <button onClick={() => { navigator.clipboard.writeText((composeFor === l.id ? composeText : l.ai?.suggested_reply) || ''); showToast('Copied'); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Copy</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => suggest(l.id)} disabled={suggesting === l.id} className="self-start text-xs text-purple-300 hover:text-purple-200 border border-purple-900/50 rounded-lg px-3 py-1.5 disabled:opacity-50">{suggesting === l.id ? 'Generating…' : '✨ Suggest a reply'}</button>
              )}
              <div className="flex gap-2 flex-wrap items-center">
                <button onClick={() => act(l.id, () => setStatus(l.id, 'interested'), `${l.name} → pipeline`)} disabled={b} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg">→ Interested</button>
                <button onClick={() => act(l.id, () => setStatus(l.id, 'declined'), `${l.name} declined`)} disabled={b} className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-lg">Not interested</button>
                <button onClick={() => act(l.id, () => setStatus(l.id, 'opted_out'), `${l.name} opted out`)} disabled={b} className="bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-3 py-1.5 rounded-lg">Opt out</button>
                <button onClick={() => { setReplyFor(replyFor === l.id ? null : l.id); setReplyText(''); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Log reply</button>
                {l.needsReply && <button onClick={() => act(l.id, async () => { const r = await fetch(`/api/proxy/leads/${l.id}/ack`, { method: 'POST' }); return { ok: r.ok, data: await r.json().catch(() => ({})) }; }, 'Acknowledged')} disabled={b} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1.5 ml-auto">Mark read</button>}
              </div>
              {replyFor === l.id && (
                <div className="flex gap-2">
                  <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="What they said next…" autoFocus className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                  <button onClick={() => replyText.trim() && act(l.id, () => logReply(l.id, replyText.trim()), 'Reply logged').then(() => setReplyFor(null))} className="bg-blue-700 hover:bg-blue-600 text-white text-sm px-3 py-2 rounded-lg">Save</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
