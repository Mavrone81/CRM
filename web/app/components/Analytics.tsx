'use client';

import React, { useEffect, useState } from 'react';
import type { Lead, Config } from './types';
import type { Status } from './status';
import { PIPELINE_ORDER, STATUS_META } from './status';
import { sessionDisplay } from './types';

const API = '/api/proxy';
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const rank = (l: Lead) => PIPELINE_ORDER.indexOf(l.status as Status);

export default function Analytics({ leads }: { leads: Lead[] }) {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { (async () => { try { setConfig(await (await fetch(`${API}/config`)).json()); } catch {} })(); }, []);

  const atOrPast = (s: Status) => leads.filter((l) => rank(l) >= PIPELINE_ORDER.indexOf(s)).length;

  const total = leads.length;
  const sent = leads.filter((l) => l.sent).length;
  const replied = leads.filter((l) => l.replies?.length).length;
  const interested = atOrPast('interested');
  const invited = atOrPast('invited');
  const confirmed = atOrPast('confirmed');
  const scheduled = atOrPast('scheduled');
  const attended = atOrPast('attended');
  const agreement = atOrPast('agreement');
  const onboarded = leads.filter((l) => l.status === 'onboarded').length;
  const declined = leads.filter((l) => l.status === 'declined' || l.status === 'opted_out').length;
  const noReply = sent - replied;

  const outcomes = [
    { label: 'Interested', n: interested, color: 'bg-green-500' },
    { label: 'Declined', n: declined, color: 'bg-red-500' },
    { label: 'Question', n: leads.filter((l) => l.status === 'question').length, color: 'bg-yellow-500' },
    { label: 'Review', n: leads.filter((l) => l.status === 'review').length, color: 'bg-orange-500' },
  ];
  const classifiedTotal = outcomes.reduce((s, o) => s + o.n, 0);

  const dist = PIPELINE_ORDER.map((s) => ({ key: s, label: STATUS_META[s].label, n: leads.filter((l) => l.status === s).length }));
  const inPipeline = dist.reduce((a, s) => a + s.n, 0);

  const cards = [
    { label: 'Total leads', value: total, sub: `${sent} messaged · ${pct(sent, total)}%` },
    { label: 'Replied', value: replied, sub: `${pct(replied, sent)}% reply rate` },
    { label: 'Interested', value: interested, sub: `${pct(interested, replied)}% of replies` },
    { label: 'Declined', value: declined, sub: `${pct(declined, replied)}% of replies` },
    { label: 'In pipeline', value: inPipeline, sub: 'active leads' },
    { label: 'Sales Reps', value: onboarded, sub: 'fully on-boarded' },
  ];

  const rates = [
    { label: 'Reply rate', a: replied, b: sent, hint: 'replied / messaged' },
    { label: 'Interest rate', a: interested, b: replied, hint: 'interested / replied' },
    { label: 'Decline rate', a: declined, b: replied, hint: 'declined / replied' },
    { label: 'Show-up rate', a: attended, b: scheduled, hint: 'attended / scheduled' },
    { label: 'Sign rate', a: agreement, b: attended, hint: 'agreements / attended' },
  ];

  const funnel = [
    { label: 'Total leads', n: total, color: 'bg-gray-500' },
    { label: 'Messaged', n: sent, color: 'bg-sky-500' },
    { label: 'Replied', n: replied, color: 'bg-blue-500' },
    { label: 'Interested', n: interested, color: 'bg-amber-500' },
    { label: 'Invited', n: invited, color: 'bg-amber-600' },
    { label: 'Confirmed', n: confirmed, color: 'bg-indigo-500' },
    { label: 'Scheduled', n: scheduled, color: 'bg-cyan-500' },
    { label: 'Attended', n: attended, color: 'bg-green-500' },
    { label: 'Agreement', n: agreement, color: 'bg-purple-500' },
    { label: 'On-board', n: onboarded, color: 'bg-emerald-400' },
  ];

  const notClosed = (l: Lead) => l.status !== 'declined' && l.status !== 'opted_out';
  const sessionRows = (list: Config['sessions'] | undefined, kind: 'briefing' | 'onboarding') =>
    [...(list || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map((s) => {
      const names = leads.filter((l) => (kind === 'onboarding' ? l.wf?.onboardingSession : l.wf?.session) === s.id && notClosed(l)).map((l) => l.name);
      return { id: s.id, display: sessionDisplay(s), cap: Number(s.capacity) || 0, names };
    });
  const briefingRows = sessionRows(config?.sessions, 'briefing');
  const onboardingRows = sessionRows(config?.onboardingSessions, 'onboarding');

  const Bar = ({ label, n, denom, color, conv }: { label: string; n: number; denom: number; color: string; conv?: number | null }) => {
    const p = pct(n, denom);
    return (
      <div className="flex items-center gap-3">
        <span className="w-24 sm:w-32 shrink-0 text-xs text-gray-400 text-right">{label}</span>
        <div className="flex-1 h-6 bg-gray-900 rounded-md overflow-hidden border border-gray-800"><div className={`h-full ${color}`} style={{ width: `${Math.max(p, n > 0 ? 3 : 0)}%` }} /></div>
        <span className="w-24 shrink-0 text-xs text-gray-300 tabular-nums">{n} <span className="text-gray-600">{p}%</span>{conv != null && <span className="text-emerald-400/80"> ↓{conv}%</span>}</span>
      </div>
    );
  };

  const sessRow = (r: { id: string; display: string; cap: number; names: string[] }) => {
    const full = r.cap > 0 && r.names.length >= r.cap;
    const p = r.cap > 0 ? Math.min(100, Math.round((r.names.length / r.cap) * 100)) : (r.names.length ? 100 : 0);
    return (
      <div key={r.id} className="py-2 border-b border-gray-800/60 last:border-0 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-200 flex-1">{r.display || '(no date set)'}</span>
          <span className={`text-xs tabular-nums shrink-0 ${full ? 'text-red-400' : 'text-gray-300'}`}>{r.names.length}{r.cap ? `/${r.cap}` : ''} booked</span>
        </div>
        <div className="h-1.5 bg-gray-900 rounded-full overflow-hidden border border-gray-800"><div className={`h-full ${full ? 'bg-red-500' : 'bg-cyan-500'}`} style={{ width: `${p}%` }} /></div>
        {r.names.length > 0 && <div className="text-[11px] text-gray-500 truncate" title={r.names.join(', ')}>{r.names.join(', ')}</div>}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 flex flex-col gap-6">
      <h2 className="text-base sm:text-lg font-semibold text-gray-100">Analytics</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="text-2xl font-bold text-gray-100 tabular-nums">{c.value}</div>
            <div className="text-xs text-gray-400 mt-1">{c.label}</div>
            <div className="text-[11px] text-gray-600 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>
      {(briefingRows.length > 0 || onboardingRows.length > 0) && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h3 className="text-sm font-semibold text-gray-200 mb-1">📅 Session calendar</h3>
          <p className="text-[11px] text-gray-600 mb-4">how many leads are booked into each session, soonest first</p>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
            <div>
              <div className="text-xs text-purple-300 font-medium mb-1">Briefing (1st, face-to-face)</div>
              {briefingRows.length === 0 ? <p className="text-xs text-gray-600">None scheduled.</p> : briefingRows.map((r) => sessRow(r))}
            </div>
            <div>
              <div className="text-xs text-sky-300 font-medium mb-1 mt-3 sm:mt-0">Onboarding</div>
              {onboardingRows.length === 0 ? <p className="text-xs text-gray-600">None scheduled.</p> : onboardingRows.map((r) => sessRow(r))}
            </div>
          </div>
        </div>
      )}
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Key rates</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {rates.map((r) => (
            <div key={r.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
              <div className="text-2xl font-bold text-green-400 tabular-nums">{pct(r.a, r.b)}%</div>
              <div className="text-xs text-gray-300 mt-1">{r.label}</div>
              <div className="text-[11px] text-gray-600 mt-0.5">{r.a}/{r.b} · {r.hint}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h3 className="text-sm font-semibold text-gray-200 mb-1">Recruitment funnel</h3>
          <p className="text-[11px] text-gray-600 mb-4">bar = % of total · <span className="text-emerald-400/80">↓</span> = conversion from step above</p>
          <div className="flex flex-col gap-2">{funnel.map((f, i) => <Bar key={f.label} label={f.label} n={f.n} denom={total} color={f.color} conv={i === 0 ? null : pct(f.n, funnel[i - 1].n)} />)}</div>
        </div>
        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-1">Reply outcomes</h3>
            <p className="text-[11px] text-gray-600 mb-4">{classifiedTotal} classified · {noReply} messaged, no reply yet</p>
            <div className="flex flex-col gap-2">{outcomes.map((o) => <Bar key={o.label} label={o.label} n={o.n} denom={classifiedTotal} color={o.color} />)}</div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">Pipeline distribution <span className="text-gray-600 font-normal">(current status)</span></h3>
            <div className="flex flex-col gap-2">{dist.map((s) => <Bar key={s.key} label={s.label} n={s.n} denom={inPipeline} color="bg-cyan-500" />)}{inPipeline === 0 && <p className="text-xs text-gray-600">No leads in the pipeline.</p>}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
