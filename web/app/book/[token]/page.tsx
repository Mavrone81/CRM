'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

type Slot = { id: string; display: string; capacity: number; booked: number; full: boolean };
type Data = { name: string; kind: 'briefing' | 'onboarding'; slots: Slot[]; current: string | null };

export default function BookPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/proxy/book/${token}`);
      const d = await r.json();
      if (r.ok) setData(d);
      else setError(d.error || 'Could not load your booking.');
    } catch { setError('Network error — please try again.'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const pick = async (id: string) => {
    setBusy(id); setError('');
    try {
      const r = await fetch(`/api/proxy/book/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
      const d = await r.json();
      if (r.ok) setDone(d.display);
      else { setError(d.error || 'Could not book that slot.'); load(); }
    } catch { setError('Network error — please try again.'); }
    finally { setBusy(null); }
  };

  const kindLabel = data?.kind === 'onboarding' ? 'onboarding session' : 'briefing session';

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-start sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl p-5 sm:p-6 mt-6 sm:mt-0">
        <div className="text-center mb-5">
          <div className="text-sm text-green-400 font-medium">Pet Afterlife SG</div>
          <h1 className="text-lg sm:text-xl font-semibold mt-1">Pick your {kindLabel}</h1>
        </div>

        {loading && <p className="text-center text-gray-500 py-8">Loading your slots…</p>}

        {error && !data && <p className="text-center text-red-400 py-8">{error}</p>}

        {done ? (
          <div className="text-center py-6 flex flex-col gap-2">
            <div className="text-4xl">✅</div>
            <p className="text-base font-medium">You&apos;re booked for</p>
            <p className="text-green-300 text-lg font-semibold">{done}</p>
            <p className="text-sm text-gray-400 mt-2">We&apos;ll see you there{data?.name ? `, ${data.name}` : ''}! You can close this page.</p>
          </div>
        ) : data && (
          <>
            <p className="text-sm text-gray-400 mb-4">{data.name ? `Hi ${data.name}! ` : ''}Choose the time that works best for you:</p>
            {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
            {data.slots.length === 0 ? (
              <p className="text-center text-gray-500 py-6">No upcoming slots are open just yet — we&apos;ll be in touch with dates shortly.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {data.slots.map((s) => {
                  const isCurrent = data.current === s.id;
                  const disabled = (s.full && !isCurrent) || busy !== null;
                  return (
                    <button
                      key={s.id}
                      onClick={() => pick(s.id)}
                      disabled={disabled}
                      className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                        isCurrent ? 'border-green-600 bg-green-950/40'
                        : s.full ? 'border-gray-800 bg-gray-900/40 opacity-50 cursor-not-allowed'
                        : 'border-gray-700 bg-gray-800 hover:border-green-600 hover:bg-gray-800/70'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{s.display}</span>
                        <span className="text-xs whitespace-nowrap">
                          {busy === s.id ? '…' : isCurrent ? <span className="text-green-400">✓ your slot</span> : s.full ? <span className="text-red-400">Full</span> : <span className="text-green-400">Choose</span>}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-gray-600 text-center mt-5">This link is just for you — please don&apos;t share it.</p>
          </>
        )}
      </div>
    </div>
  );
}
