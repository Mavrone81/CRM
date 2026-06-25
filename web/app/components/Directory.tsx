'use client';

import React, { useState } from 'react';
import type { Lead } from './types';
import type { Status } from './status';
import { ALL_STATUSES, STATUS_META } from './status';
import { API, logReply, setStatus } from './leadApi';

const GROUPS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'closed', label: 'Closed' },
];

export default function Directory({ leads, showToast, refresh }: { leads: Lead[]; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '' });
  const [saving, setSaving] = useState(false);

  const visible = leads.filter((l) => {
    const s = (l.status || 'new') as Status;
    const matchGroup = group === 'all' || STATUS_META[s]?.group === group;
    const q = search.toLowerCase();
    const matchSearch = !q || l.name.toLowerCase().includes(q) || l.phone.includes(search) || (l.email || '').toLowerCase().includes(q);
    return matchGroup && matchSearch;
  });

  const change = async (id: number, status: Status) => {
    const { ok, data } = await setStatus(id, status);
    if (ok && data.ok) { showToast('Status updated'); refresh(); } else showToast(data.error || 'Failed', false);
  };

  const addLead = async () => {
    if (!addForm.name.trim() || !addForm.phone.trim()) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(addForm) });
      if (r.ok) { showToast(`Added ${addForm.name}`); setAddForm({ name: '', phone: '', email: '', notes: '', adviser: '' }); setShowAdd(false); refresh(); }
      else showToast('Failed to add', false);
    } catch { showToast('Network error', false); } finally { setSaving(false); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-2 sm:gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email…" className="w-full sm:flex-1 sm:w-auto bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600" />
        <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1 overflow-x-auto max-w-full">
          {GROUPS.map((g) => <button key={g.key} onClick={() => setGroup(g.key)} className={`px-3 py-1 rounded text-sm whitespace-nowrap ${group === g.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{g.label}</button>)}
        </div>
        <button onClick={() => setShowAdd(true)} className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap">+ Add Lead</button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-950 border-b border-gray-800">
            <tr>
              <th className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium">Name</th>
              <th className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium">Phone</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium hidden md:table-cell">Last reply</th>
              <th className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium">Status</th>
              <th className="px-4 py-3 text-right text-gray-400 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-900">
            {visible.map((l) => {
              const s = (l.status || 'new') as Status;
              const meta = STATUS_META[s];
              const lr = l.replies?.[l.replies.length - 1];
              return (
                <React.Fragment key={l.id}>
                  <tr className="hover:bg-gray-900/50">
                    <td className="px-3 sm:px-4 py-3">
                      <div className="font-medium text-gray-100 flex items-center gap-1.5">{l.name}{l.needsReply && <span className="text-[10px] px-1.5 rounded-full bg-blue-900 border border-blue-700 text-blue-200">new</span>}</div>
                      <div className="text-xs text-gray-500 truncate max-w-[160px] sm:max-w-none">{l.email}</div>
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-gray-300 font-mono text-xs whitespace-nowrap">{l.phone}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-gray-500 max-w-[240px] truncate">{lr ? `“${lr.text}”` : '—'}</td>
                    <td className="px-3 sm:px-4 py-3">
                      <select value={s} onChange={(e) => change(l.id, e.target.value as Status)} className={`text-xs rounded-full border px-2 py-1 focus:outline-none cursor-pointer ${meta.chip}`}>
                        {ALL_STATUSES.map((opt) => <option key={opt} value={opt} className="bg-gray-900 text-gray-200">{STATUS_META[opt].label}</option>)}
                      </select>
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-right">
                      <button onClick={() => { setReplyFor(replyFor === l.id ? null : l.id); setReplyText(''); }} className="text-xs text-gray-400 hover:text-gray-200">Log reply</button>
                    </td>
                  </tr>
                  {replyFor === l.id && (
                    <tr className="bg-gray-900/40"><td colSpan={5} className="px-4 py-2">
                      <div className="flex gap-2">
                        <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder={`What ${l.name} said…`} autoFocus className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                        <button onClick={async () => { if (!replyText.trim()) return; const { ok } = await logReply(l.id, replyText.trim()); if (ok) { showToast('Reply logged + classified'); setReplyFor(null); refresh(); } }} className="bg-blue-700 hover:bg-blue-600 text-white text-sm px-3 py-2 rounded-lg">Save</button>
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {visible.length === 0 && <tr><td colSpan={5} className="px-4 py-16 text-center text-gray-600">No leads match.</td></tr>}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-100 mb-5">Add Lead</h2>
            <div className="flex flex-col gap-4">
              {([['Name *', 'name'], ['Phone *', 'phone'], ['Email', 'email'], ['Adviser', 'adviser'], ['Notes', 'notes']] as const).map(([label, key]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">{label}</label>
                  <input value={addForm[key]} onChange={(e) => setAddForm((p) => ({ ...p, [key]: e.target.value }))} className="min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg px-3 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowAdd(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg">Cancel</button>
              <button onClick={addLead} disabled={saving || !addForm.name.trim() || !addForm.phone.trim()} className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg">{saving ? 'Saving…' : 'Add'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
