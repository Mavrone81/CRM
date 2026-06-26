'use client';

import React, { useEffect, useState } from 'react';
import type { Config, Session, DocMeta } from './types';
import { sessionDisplay } from './types';

const API = '/api/proxy';
async function post(path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

type Tab = 'sessions' | 'onboarding' | 'documents';

export default function Settings({ onClose, showToast }: { onClose: () => void; showToast: (m: string, ok?: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('sessions');
  const [config, setConfig] = useState<Config | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [obSessions, setObSessions] = useState<Session[]>([]);
  const [required, setRequired] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadConfig = async () => { try { const c = await (await fetch(`${API}/config`)).json(); setConfig(c); setSessions(c.sessions || []); setObSessions(c.onboardingSessions || []); setRequired((c.requiredFields || []).join('\n')); } catch {} };
  const loadDocs = async () => { try { setDocs(await (await fetch(`${API}/documents`)).json()); } catch {} };
  useEffect(() => { loadConfig(); loadDocs(); }, []);

  const save = async (body: object, msg: string) => { setSaving(true); const { ok, data } = await post('/config', body); setSaving(false); if (ok && data.ok) { showToast(msg); loadConfig(); } else showToast('Save failed', false); };

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(file); });
      const { ok } = await post('/documents', { name: file.name, mimetype: file.type || 'application/pdf', dataBase64: dataUrl.split(',')[1] });
      if (ok) { showToast(`Uploaded ${file.name}`); loadDocs(); } else showToast('Upload failed', false);
    } catch { showToast('Upload failed', false); } finally { setUploading(false); }
  };

  const SessionEditor = ({ rows, set, idPrefix }: { rows: Session[]; set: (fn: (d: Session[]) => Session[]) => void; idPrefix: string }) => (
    <>
      {rows.map((s, i) => (
        <div key={i} className="flex flex-col gap-1 border border-gray-800 rounded-lg p-2">
          <div className="flex gap-2 items-center flex-wrap sm:flex-nowrap">
            <input type="date" value={s.date || ''} onChange={(e) => set((d) => d.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
            <input type="time" value={s.time || ''} onChange={(e) => set((d) => d.map((x, j) => j === i ? { ...x, time: e.target.value } : x))} className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
            <input type="number" min={0} value={s.capacity || ''} title="Capacity" placeholder="cap" onChange={(e) => set((d) => d.map((x, j) => j === i ? { ...x, capacity: e.target.value === '' ? 0 : Math.max(0, parseInt(e.target.value, 10) || 0) } : x))} className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
            <button onClick={() => set((d) => d.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 px-2">✕</button>
          </div>
          <span className="text-xs text-gray-400 pl-1">→ {sessionDisplay(s)} · cap {s.capacity}</span>
        </div>
      ))}
      <button onClick={() => set((d) => [...d, { id: `${idPrefix}${Date.now()}`, date: '', time: '', capacity: 10 }])} className="text-sm text-gray-400 hover:text-gray-200 self-start">+ Add session</button>
    </>
  );

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex border-b border-gray-800 overflow-x-auto">
          {(['sessions', 'onboarding', 'documents'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-3 text-sm whitespace-nowrap capitalize ${tab === t ? 'text-green-400 border-b-2 border-green-500' : 'text-gray-400 hover:text-gray-200'}`}>{t}</button>
          ))}
          <button onClick={onClose} className="ml-auto px-4 text-gray-500 hover:text-gray-200 shrink-0">✕</button>
        </div>
        <div className="p-5 overflow-auto flex flex-col gap-3">
          {tab === 'sessions' && (<>
            <label className="text-xs text-gray-400">Briefing sessions — pick a date + time; the day is derived. Leads are scheduled into these.</label>
            <SessionEditor rows={sessions} set={setSessions} idPrefix="s" />
            <button onClick={() => save({ sessions: sessions.filter((s) => s.date || s.label) }, 'Sessions saved')} disabled={saving} className="self-end bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">{saving ? 'Saving…' : 'Save'}</button>
          </>)}
          {tab === 'onboarding' && (<>
            <label className="text-xs text-gray-400">Onboarding (2nd) sessions</label>
            <SessionEditor rows={obSessions} set={setObSessions} idPrefix="ob" />
            <label className="text-xs text-gray-400 mt-2">Required fields on the signed agreement — one per line (drives auto-validation)</label>
            <textarea rows={6} value={required} onChange={(e) => setRequired(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600" />
            <button onClick={() => save({ onboardingSessions: obSessions.filter((s) => s.date || s.label), requiredFields: required.split('\n').map((x) => x.trim()).filter(Boolean) }, 'Onboarding saved')} disabled={saving} className="self-end bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">{saving ? 'Saving…' : 'Save'}</button>
          </>)}
          {tab === 'documents' && (<>
            <label className="text-xs text-gray-400">Agreement documents — ⭐ default is the one you send at the Attended stage</label>
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-2 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2">
                <button title={d.isDefault ? 'Default' : 'Set default'} onClick={async () => { await post(`/documents/${d.id}/default`); loadDocs(); }} className={d.isDefault ? 'text-yellow-400' : 'text-gray-600 hover:text-yellow-300'}>★</button>
                <span className="flex-1 text-sm text-gray-200 truncate">{d.name}</span>
                <span className="text-xs text-gray-500">{Math.round(d.size / 1024)} KB</span>
                <button onClick={async () => { await fetch(`${API}/documents/${d.id}`, { method: 'DELETE' }); loadDocs(); }} className="text-gray-500 hover:text-red-400">✕</button>
              </div>
            ))}
            {docs.length === 0 && <p className="text-xs text-gray-600">No documents yet.</p>}
            <label className={`self-start text-sm px-4 py-2 rounded-lg cursor-pointer ${uploading ? 'opacity-50' : ''} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`}>
              {uploading ? 'Uploading…' : '+ Upload document'}
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} disabled={uploading} />
            </label>
          </>)}
        </div>
      </div>
    </div>
  );
}
