'use client';

import React, { useEffect, useState } from 'react';
import type { Lead, Config } from './types';

const API = '/api/proxy';

const RANK: Record<string, number> = { brief: 1, confirmed: 2, slotted: 3, attended: 4, agreement_sent: 5 };

// Furthest pipeline rank a lead has reached (interested auto-surfaces to brief = 1).
function rankOf(l: Lead): number {
  if (l.stage && l.stage !== 'declined') return RANK[l.stage] || 0;
  if (!l.stage && l.ai?.category === 'interested') return 1;
  return 0;
}

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
  const agreement = leads.filter((l) => l.stage === 'agreement_sent').length;
  const declined = leads.filter((l) => l.stage === 'declined').length;

  const replyCats = (['interested', 'not_interested', 'question', 'other'] as const).map((c) => ({
    key: c,
    label: c === 'not_interested' ? 'Not interested' : c[0].toUpperCase() + c.slice(1),
    n: leads.filter((l) => l.ai?.category === c).length,
  }));
  const classified = replyCats.reduce((s, c) => s + c.n, 0);

  // Funnel — count reaching each step, % vs the previous step.
  const funnel = [
    { label: 'Total leads', n: total, color: 'bg-gray-500' },
    { label: 'Messaged', n: sent, color: 'bg-sky-500' },
    { label: 'Replied', n: replied, color: 'bg-blue-500' },
    { label: 'Interested', n: interested, color: 'bg-amber-500' },
    { label: 'Briefed (invited)', n: invited, color: 'bg-amber-600' },
    { label: 'Confirmed', n: confirmed, color: 'bg-indigo-500' },
    { label: 'Slotted', n: slotted, color: 'bg-cyan-500' },
    { label: 'Attended', n: attended, color: 'bg-green-500' },
    { label: 'Agreement sent', n: agreement, color: 'bg-purple-500' },
  ];

  const cards = [
    { label: 'Total leads', value: total, sub: `${sent} messaged` },
    { label: 'Replies', value: replied, sub: total ? `${Math.round((replied / total) * 100)}% reply rate` : '—' },
    { label: 'Interested', value: interested, sub: replied ? `${Math.round((interested / replied) * 100)}% of replies` : '—' },
    { label: 'In pipeline', value: interested - declined > 0 ? interested - declined : interested, sub: `${declined} declined` },
    { label: 'Attended', value: attended, sub: 'recruitment session' },
    { label: 'Agreements sent', value: agreement, sub: 'awaiting signed' },
  ];

  const sessionFill = (config?.sessions || []).map((s) => ({
    label: s.label + (s.date ? ` · ${s.date}` : ''),
    n: leads.filter((l) => l.wf?.session === s.id && rankOf(l) >= 3).length,
    cap: s.capacity,
  }));

  const Bar = ({ label, n, denom, color }: { label: string; n: number; denom: number; color: string }) => {
    const pct = denom > 0 ? Math.round((n / denom) * 100) : 0;
    return (
      <div className="flex items-center gap-3">
        <span className="w-36 shrink-0 text-xs text-gray-400 text-right">{label}</span>
        <div className="flex-1 h-6 bg-gray-900 rounded-md overflow-hidden border border-gray-800">
          <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(pct, n > 0 ? 3 : 0)}%` }} />
        </div>
        <span className="w-16 shrink-0 text-xs text-gray-300 tabular-nums">{n} <span className="text-gray-600">{pct}%</span></span>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 flex flex-col gap-6">
      <h2 className="text-base sm:text-lg font-semibold text-gray-100">Analytics</h2>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="text-2xl font-bold text-gray-100 tabular-nums">{c.value}</div>
            <div className="text-xs text-gray-400 mt-1">{c.label}</div>
            <div className="text-[11px] text-gray-600 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Funnel */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">Recruitment funnel</h3>
          <div className="flex flex-col gap-2">
            {funnel.map((f) => <Bar key={f.label} label={f.label} n={f.n} denom={total} color={f.color} />)}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {/* Reply breakdown */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">Reply classification <span className="text-gray-600 font-normal">({classified} classified)</span></h3>
            <div className="flex flex-col gap-2">
              {replyCats.map((c) => (
                <Bar key={c.key} label={c.label} n={c.n} denom={classified}
                  color={c.key === 'interested' ? 'bg-green-500' : c.key === 'not_interested' ? 'bg-red-500' : c.key === 'question' ? 'bg-yellow-500' : 'bg-gray-500'} />
              ))}
            </div>
          </div>

          {/* Session fill */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">Session fill</h3>
            <div className="flex flex-col gap-2">
              {sessionFill.length === 0 && <p className="text-xs text-gray-600">No sessions configured.</p>}
              {sessionFill.map((s) => (
                <Bar key={s.label} label={s.label} n={s.n} denom={s.cap} color={s.n >= s.cap ? 'bg-red-500' : 'bg-cyan-500'} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
