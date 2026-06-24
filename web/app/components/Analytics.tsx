'use client';

import React, { useEffect, useState } from 'react';
import type { Lead, Config } from './types';
import { sessionDisplay } from './types';

const API = '/api/proxy';

const RANK: Record<string, number> = { brief: 1, confirmed: 2, slotted: 3, attended: 4, agreement_sent: 5, onboarding: 6, onboarding_slotted: 7, onboarded: 8 };
function rankOf(l: Lead): number {
  if (l.stage && l.stage !== 'declined') return RANK[l.stage] || 0;
  if (!l.stage && l.ai?.category === 'interested') return 1;
  return 0;
}
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export default function Analytics({ leads }: { leads: Lead[] }) {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { (async () => { try { setConfig(await (await fetch(`${API}/config`)).json()); } catch {} })(); }, []);

  const total = leads.length;
  const sent = leads.filter((l) => l.sent).length;
  const replied = leads.filter((l) => l.replies?.length).length;
  const interested = leads.filter((l) => rankOf(l) >= 1).length;
  const invited = leads.filter((l) => l.wf?.invitedAt).length;
  const confirmed = leads.filter((l) => rankOf(l) >= 2).length;
  const slotted = leads.filter((l) => rankOf(l) >= 3).length;
  const attended = leads.filter((l) => rankOf(l) >= 4).length;
  const agreement = leads.filter((l) => rankOf(l) >= 5).length;
  const onboarded = leads.filter((l) => l.stage === 'onboarded').length;
  const declined = leads.filter((l) => l.stage === 'declined' || l.ai?.category === 'not_interested').length;
  const noReply = sent - replied;

  // Reply classification counts
  const cats = [
    { key: 'interested', label: 'Interested', n: leads.filter((l) => l.ai?.category === 'interested').length, color: 'bg-green-500' },
    { key: 'not_interested', label: 'Not interested', n: leads.filter((l) => l.ai?.category === 'not_interested').length, color: 'bg-red-500' },
    { key: 'question', label: 'Question', n: leads.filter((l) => l.ai?.category === 'question').length, color: 'bg-yellow-500' },
    { key: 'other', label: 'Other', n: leads.filter((l) => l.ai?.category === 'other').length, color: 'bg-gray-500' },
  ];
  const classified = cats.reduce((s, c) => s + c.n, 0);

  // Current-stage distribution
  const stageDist = [
    { key: 'brief', label: 'Brief', color: 'bg-amber-500' },
    { key: 'confirmed', label: 'Confirmed', color: 'bg-indigo-500' },
    { key: 'slotted', label: 'Slotted', color: 'bg-cyan-500' },
    { key: 'attended', label: 'Attended', color: 'bg-green-500' },
    { key: 'agreement_sent', label: 'Agreement', color: 'bg-purple-500' },
    { key: 'onboarding', label: 'Onboarding', color: 'bg-teal-500' },
    { key: 'onboarding_slotted', label: 'Booked', color: 'bg-emerald-500' },
    { key: 'onboarded', label: 'On-board', color: 'bg-green-400' },
  ].map((s) => ({ ...s, n: leads.filter((l) => l.stage === s.key).length }));
  const inPipeline = stageDist.reduce((a, s) => a + s.n, 0) + leads.filter((l) => !l.stage && l.ai?.category === 'interested').length;

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
    { label: 'Show-up rate', a: attended, b: slotted, hint: 'attended / slotted' },
    { label: 'Sign rate', a: agreement, b: attended, hint: 'agreements / attended' },
  ];

  // Funnel with step-over-step conversion
  const funnelRows = [
    { label: 'Total leads', n: total, color: 'bg-gray-500' },
    { label: 'Messaged', n: sent, color: 'bg-sky-500' },
    { label: 'Replied', n: replied, color: 'bg-blue-500' },
    { label: 'Interested', n: interested, color: 'bg-amber-500' },
    { label: 'Briefed', n: invited, color: 'bg-amber-600' },
    { label: 'Confirmed', n: confirmed, color: 'bg-indigo-500' },
    { label: 'Slotted', n: slotted, color: 'bg-cyan-500' },
    { label: 'Attended', n: attended, color: 'bg-green-500' },
    { label: 'Agreement', n: agreement, color: 'bg-purple-500' },
    { label: 'On-board', n: onboarded, color: 'bg-emerald-400' },
  ];

  const sessionFill = (config?.sessions || []).map((s) => ({ label: sessionDisplay(s), n: leads.filter((l) => l.wf?.session === s.id && rankOf(l) >= 3).length, cap: s.capacity }));

  const Bar = ({ label, n, denom, color, conv }: { label: string; n: number; denom: number; color: string; conv?: number | null }) => {
    const p = pct(n, denom);
    return (
      <div className="flex items-center gap-3">
        <span className="w-24 sm:w-32 shrink-0 text-xs text-gray-400 text-right">{label}</span>
        <div className="flex-1 h-6 bg-gray-900 rounded-md overflow-hidden border border-gray-800">
          <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(p, n > 0 ? 3 : 0)}%` }} />
        </div>
        <span className="w-24 shrink-0 text-xs text-gray-300 tabular-nums">
          {n} <span className="text-gray-600">{p}%</span>
          {conv != null && <span className="text-emerald-400/80"> ↓{conv}%</span>}
        </span>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 flex flex-col gap-6">
      <h2 className="text-base sm:text-lg font-semibold text-gray-100">Analytics</h2>

      {/* Headline counts */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="text-2xl font-bold text-gray-100 tabular-nums">{c.value}</div>
            <div className="text-xs text-gray-400 mt-1">{c.label}</div>
            <div className="text-[11px] text-gray-600 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Key conversion rates */}
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Key rates</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {rates.map((r) => {
            const p = pct(r.a, r.b);
            return (
              <div key={r.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                <div className="text-2xl font-bold text-green-400 tabular-nums">{p}%</div>
                <div className="text-xs text-gray-300 mt-1">{r.label}</div>
                <div className="text-[11px] text-gray-600 mt-0.5">{r.a}/{r.b} · {r.hint}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Funnel with conversions */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h3 className="text-sm font-semibold text-gray-200 mb-1">Recruitment funnel</h3>
          <p className="text-[11px] text-gray-600 mb-4">bar = % of total · <span className="text-emerald-400/80">↓</span> = conversion from step above</p>
          <div className="flex flex-col gap-2">
            {funnelRows.map((f, i) => (
              <Bar key={f.label} label={f.label} n={f.n} denom={total} color={f.color}
                conv={i === 0 ? null : pct(f.n, funnelRows[i - 1].n)} />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {/* Reply outcomes */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-1">Reply outcomes</h3>
            <p className="text-[11px] text-gray-600 mb-4">{classified} classified · {noReply} messaged with no reply yet</p>
            <div className="flex flex-col gap-2">
              {cats.map((c) => <Bar key={c.key} label={c.label} n={c.n} denom={classified} color={c.color} />)}
            </div>
          </div>

          {/* Current pipeline distribution */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">Pipeline distribution <span className="text-gray-600 font-normal">(current stage)</span></h3>
            <div className="flex flex-col gap-2">
              {stageDist.map((s) => <Bar key={s.key} label={s.label} n={s.n} denom={inPipeline} color={s.color} />)}
              {inPipeline === 0 && <p className="text-xs text-gray-600">No leads in the pipeline yet.</p>}
            </div>
          </div>

          {/* Session fill */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">Session fill</h3>
            <div className="flex flex-col gap-2">
              {sessionFill.length === 0 && <p className="text-xs text-gray-600">No sessions configured.</p>}
              {sessionFill.map((s) => <Bar key={s.label} label={s.label} n={s.n} denom={s.cap} color={s.n >= s.cap ? 'bg-red-500' : 'bg-cyan-500'} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
