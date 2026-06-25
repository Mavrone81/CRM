'use client';

import React, { useState } from 'react';
import type { WaNumber } from './types';

const API = '/api/proxy';

const STATE_CHIP: Record<string, string> = {
  open: 'bg-green-950 border-green-700 text-green-300',
  connecting: 'bg-yellow-950 border-yellow-700 text-yellow-300',
  banned: 'bg-red-950 border-red-800 text-red-300',
  close: 'bg-gray-900 border-gray-700 text-gray-400',
};
const STATE_LABEL: Record<string, string> = { open: 'Connected', connecting: 'Scan QR', banned: 'Blocked', close: 'Disconnected' };

export default function Numbers({ numbers, onClose, showToast, refresh }: { numbers: WaNumber[]; onClose: () => void; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try { const r = await fetch(`${API}/numbers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok) { showToast('Number added — scan its QR'); refresh(); } else showToast('Max 10 numbers, or failed', false); }
    catch { showToast('Network error', false); } finally { setBusy(false); }
  };
  const relink = async (id: string) => { await fetch(`${API}/numbers/${id}/relink`, { method: 'POST' }); showToast('Generating QR…'); refresh(); };
  const remove = async (id: string) => { if (!confirm('Remove this number? Its session is cleared.')) return; await fetch(`${API}/numbers/${id}`, { method: 'DELETE' }); showToast('Removed'); refresh(); };

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
                <span className={`text-xs px-2 py-0.5 rounded-full border ${STATE_CHIP[n.state] || STATE_CHIP.close}`}>{STATE_LABEL[n.state] || n.state}</span>
                <div className="ml-auto flex gap-2">
                  <button onClick={() => relink(n.id)} className="text-xs text-gray-400 hover:text-gray-200">Relink</button>
                  {numbers.length > 1 && <button onClick={() => remove(n.id)} className="text-xs text-gray-500 hover:text-red-400">Remove</button>}
                </div>
              </div>
              {n.state !== 'open' && (n.qr
                ? <img src={n.qr} alt="QR" className="w-48 h-48 rounded-lg bg-white p-1 self-center" />
                : <button onClick={() => relink(n.id)} className="self-start text-sm bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg">Generate QR</button>)}
            </div>
          ))}
          <button onClick={add} disabled={busy} className="text-sm text-gray-300 hover:text-white border border-dashed border-gray-700 rounded-lg py-2 disabled:opacity-50">+ Add a number</button>
          <p className="text-[11px] text-gray-600">Each lead sticks to the number it talks to. To link: scan a number's QR with WhatsApp → Linked devices → Link a device.</p>
        </div>
      </div>
    </div>
  );
}
