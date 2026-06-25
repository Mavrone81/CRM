'use client';

import React, { useState } from 'react';
import type { Lead, WaNumber } from './types';
import type { Status } from './status';
import { ALL_STATUSES, STATUS_META } from './status';
import { relTime, lastContactOf, lastReplyOf } from './types';
import { API, logReply, setStatus, updateLead } from './leadApi';

const GROUPS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'closed', label: 'Closed' },
];

type ImportRow = { name: string; phone: string; email: string; notes: string; adviser: string };
// Parse CSV (quoted fields supported). Maps flexible headers; falls back to
// name,phone,email column order when there's no recognisable header row.
function parseCSV(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const parseLine = (line: string) => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const alias: Record<keyof ImportRow, string[]> = {
    name: ['name', 'full name', 'lead name', 'contact', 'contact name'],
    phone: ['phone', 'mobile', 'number', 'contact number', 'phone number', 'hp', 'mobile number', 'tel'],
    email: ['email', 'e-mail'],
    notes: ['notes', 'note', 'remark', 'remarks'],
    adviser: ['adviser', 'advisor', 'agent', 'referrer', 'source'],
  };
  const idx: Record<string, number> = {};
  (Object.keys(alias) as (keyof ImportRow)[]).forEach((k) => { idx[k] = headers.findIndex((h) => alias[k].includes(h)); });
  const hasHeader = idx.name >= 0 || idx.phone >= 0;
  const data = hasHeader ? lines.slice(1) : lines;
  const get = (cells: string[], i: number) => (i >= 0 ? (cells[i] || '').trim() : '');
  return data.map((line) => {
    const c = parseLine(line);
    return hasHeader
      ? { name: get(c, idx.name), phone: get(c, idx.phone), email: get(c, idx.email), notes: get(c, idx.notes), adviser: get(c, idx.adviser) }
      : { name: (c[0] || '').trim(), phone: (c[1] || '').trim(), email: (c[2] || '').trim(), notes: '', adviser: '' };
  }).filter((r) => r.name || r.phone);
}

export default function Directory({ leads, numbers, showToast, refresh }: { leads: Lead[]; numbers: WaNumber[]; showToast: (m: string, ok?: boolean) => void; refresh: () => void }) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  // Count of leads per status (drives the status-workflow chips).
  const statusCount: Record<string, number> = {};
  leads.forEach((l) => { const s = (l.status || 'new'); statusCount[s] = (statusCount[s] || 0) + 1; });
  const sortBy = (key: string) => setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '' });
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<Lead | null>(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '', assignedNumber: '' });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ added: number; total: number; skipped: { name: string; phone: string; reason: string }[] } | null>(null);

  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      const rows = parseCSV(await file.text());
      if (!rows.length) { showToast('No rows found in the CSV', false); return; }
      const r = await fetch(`${API}/leads/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setImportResult(d); refresh(); } else showToast(d.error || 'Import failed', false);
    } catch { showToast('Could not read the file', false); } finally { setImporting(false); }
  };

  const numLabel = (id?: string) => numbers.find((n) => n.id === id)?.label || (id ? id : '—');
  const openEdit = (l: Lead) => { setEdit(l); setEditForm({ name: l.name || '', phone: l.phone || '', email: l.email || '', notes: l.notes || '', adviser: l.adviser || '', assignedNumber: (l as Lead & { assignedNumber?: string }).assignedNumber || '' }); };
  const saveEdit = async () => {
    if (!edit) return;
    setSaving(true);
    const { ok, data } = await updateLead(edit.id, { ...editForm, assignedNumber: editForm.assignedNumber || null });
    setSaving(false);
    if (ok && (data.id || data.ok !== false)) { showToast('Lead updated'); setEdit(null); refresh(); } else showToast(data.error || 'Update failed', false);
  };

  const visible = leads.filter((l) => {
    const s = (l.status || 'new') as Status;
    const matchGroup = group === 'all' || STATUS_META[s]?.group === group;
    const matchStatus = statusFilter === 'all' || s === statusFilter;
    const q = search.toLowerCase();
    const matchSearch = !q || l.name.toLowerCase().includes(q) || l.phone.includes(search) || (l.email || '').toLowerCase().includes(q);
    return matchGroup && matchStatus && matchSearch;
  });

  const sortVal = (l: Lead): string | number => {
    if (sort.key === 'phone') return l.phone || '';
    if (sort.key === 'status') return ALL_STATUSES.indexOf((l.status || 'new') as Status);
    if (sort.key === 'activity') { const t = lastContactOf(l); return t ? new Date(t).getTime() : 0; }
    return (l.name || '').toLowerCase();
  };
  const sorted = [...visible].sort((a, b) => { const av = sortVal(a), bv = sortVal(b); return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir; });

  const change = async (id: number, status: Status) => {
    const { ok, data } = await setStatus(id, status);
    if (ok && data.ok) { showToast('Status updated'); refresh(); } else showToast(data.error || 'Failed', false);
  };

  // Live duplicate check against loaded leads (same phone last-8, or same name).
  const addDup = (() => {
    const digits = addForm.phone.replace(/\D/g, '');
    const nameL = addForm.name.trim().toLowerCase();
    if (digits.length < 8 && !nameL) return null;
    return leads.find((l) => {
      const ld = (l.phone || '').replace(/\D/g, '');
      const phoneMatch = digits.length >= 8 && ld.length >= 8 && ld.slice(-8) === digits.slice(-8);
      const nameMatch = !!nameL && l.name.trim().toLowerCase() === nameL;
      return phoneMatch || nameMatch;
    }) || null;
  })();

  const doAdd = async (force: boolean) => {
    const r = await fetch(`${API}/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...addForm, force }) });
    if (r.status === 409) {
      const d = await r.json().catch(() => ({}));
      const e = d.existing || {};
      if (confirm(`⚠ Possible duplicate (matched by ${d.matchedBy}):\n\n${e.name} — ${e.phone} (${e.status || 'lead'})\n\nAdd this new lead anyway?`)) return doAdd(true);
      return;
    }
    if (r.ok) { showToast(`Added ${addForm.name}`); setAddForm({ name: '', phone: '', email: '', notes: '', adviser: '' }); setShowAdd(false); refresh(); }
    else showToast('Failed to add', false);
  };
  const addLead = async () => {
    if (!addForm.name.trim() || !addForm.phone.trim()) return;
    setSaving(true);
    try { await doAdd(false); } catch { showToast('Network error', false); } finally { setSaving(false); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-2 sm:gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email…" className="w-full sm:flex-1 sm:w-auto bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600" />
        <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1 overflow-x-auto max-w-full">
          {GROUPS.map((g) => <button key={g.key} onClick={() => { setGroup(g.key); setStatusFilter('all'); }} className={`px-3 py-1 rounded text-sm whitespace-nowrap ${group === g.key && statusFilter === 'all' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{g.label}</button>)}
        </div>
        <label className={`bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap cursor-pointer ${importing ? 'opacity-50' : ''}`}>
          {importing ? 'Importing…' : 'Import CSV'}
          <input type="file" accept=".csv,text/csv" className="hidden" disabled={importing} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ''; }} />
        </label>
        <button onClick={() => setShowAdd(true)} className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap">+ Add Lead</button>
      </div>

      {/* Status workflow: click a status to see only those leads */}
      <div className="px-4 sm:px-6 py-2 border-b border-gray-800 flex gap-1.5 overflow-x-auto">
        <button onClick={() => { setStatusFilter('all'); setGroup('all'); }} className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap border ${statusFilter === 'all' ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'}`}>All <span className="opacity-60">{leads.length}</span></button>
        {ALL_STATUSES.filter((s) => statusCount[s]).map((s) => (
          <button key={s} onClick={() => { setStatusFilter(s); setGroup('all'); }} className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap border ${statusFilter === s ? `${STATUS_META[s].chip} border-current` : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'}`}>{STATUS_META[s].label} <span className="opacity-60">{statusCount[s]}</span></button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-950 border-b border-gray-800">
            <tr>
              <th onClick={() => sortBy('name')} className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium cursor-pointer hover:text-gray-200 select-none">Name{arrow('name')}</th>
              <th onClick={() => sortBy('phone')} className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium cursor-pointer hover:text-gray-200 select-none">Phone{arrow('phone')}</th>
              <th onClick={() => sortBy('activity')} className="px-4 py-3 text-left text-gray-400 font-medium hidden md:table-cell cursor-pointer hover:text-gray-200 select-none">Activity{arrow('activity')}</th>
              <th onClick={() => sortBy('status')} className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium cursor-pointer hover:text-gray-200 select-none">Status{arrow('status')}</th>
              <th className="px-4 py-3 text-right text-gray-400 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-900">
            {sorted.map((l) => {
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
                    <td className="px-3 sm:px-4 py-3 text-xs whitespace-nowrap">
                      <div className="text-gray-300 font-mono">{l.phone || '—'}</div>
                      <div className="text-[10px] text-gray-500">{l.channel === 'telegram' ? '✈ Telegram' : `📱 ${numLabel(l.assignedNumber)}`}</div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs max-w-[240px]">
                      <div className="text-gray-400">contacted {relTime(lastContactOf(l)) || 'never'}{lastReplyOf(l) ? ` · replied ${relTime(lastReplyOf(l))}` : ''}</div>
                      <div className="text-gray-600 truncate">{lr ? `“${lr.text}”` : 'no reply yet'}</div>
                    </td>
                    <td className="px-3 sm:px-4 py-3">
                      <select value={s} onChange={(e) => change(l.id, e.target.value as Status)} className={`text-xs rounded-full border px-2 py-1 focus:outline-none cursor-pointer ${meta.chip}`}>
                        {ALL_STATUSES.map((opt) => <option key={opt} value={opt} className="bg-gray-900 text-gray-200">{STATUS_META[opt].label}</option>)}
                      </select>
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(l)} className="text-xs text-gray-400 hover:text-gray-200 mr-3">Edit</button>
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
            {sorted.length === 0 && <tr><td colSpan={5} className="px-4 py-16 text-center text-gray-600">No leads match.</td></tr>}
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
            {addDup && (
              <div className="mt-4 text-xs text-amber-300 bg-amber-950/30 border border-amber-800 rounded-lg px-3 py-2">
                ⚠ Possible duplicate: <span className="font-medium">{addDup.name}</span> — {addDup.phone || 'no phone'} ({addDup.status || 'lead'}). You can still add it.
              </div>
            )}
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowAdd(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg">Cancel</button>
              <button onClick={addLead} disabled={saving || !addForm.name.trim() || !addForm.phone.trim()} className={`flex-1 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg ${addDup ? 'bg-amber-600 hover:bg-amber-500' : 'bg-green-600 hover:bg-green-500'}`}>{saving ? 'Saving…' : addDup ? 'Add anyway' : 'Add'}</button>
            </div>
          </div>
        </div>
      )}

      {edit && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-100 mb-5">Edit lead</h2>
            <div className="flex flex-col gap-4">
              {([['Name', 'name'], ['Phone', 'phone'], ['Email', 'email'], ['Adviser', 'adviser'], ['Notes', 'notes']] as const).map(([label, key]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">{label}</label>
                  <input value={editForm[key]} onChange={(e) => setEditForm((p) => ({ ...p, [key]: e.target.value }))} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                </div>
              ))}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-400">Assigned WhatsApp number</label>
                <select value={editForm.assignedNumber} onChange={(e) => setEditForm((p) => ({ ...p, assignedNumber: e.target.value }))} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600">
                  <option value="">— none / auto-assign on reply —</option>
                  {numbers.map((n) => <option key={n.id} value={n.id}>{n.label} ({n.state})</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setEdit(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {importResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setImportResult(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-100 mb-4">Import complete</h2>
            <div className="flex gap-3 mb-4">
              <div className="flex-1 rounded-xl border border-green-800 bg-green-950/30 p-3 text-center"><div className="text-2xl font-bold text-green-300">{importResult.added}</div><div className="text-xs text-gray-400">added</div></div>
              <div className="flex-1 rounded-xl border border-amber-800 bg-amber-950/20 p-3 text-center"><div className="text-2xl font-bold text-amber-300">{importResult.skipped.length}</div><div className="text-xs text-gray-400">skipped</div></div>
              <div className="flex-1 rounded-xl border border-gray-700 bg-gray-900 p-3 text-center"><div className="text-2xl font-bold text-gray-200">{importResult.total}</div><div className="text-xs text-gray-400">rows</div></div>
            </div>
            {importResult.skipped.length > 0 && (
              <div className="text-xs text-gray-400 max-h-48 overflow-auto border border-gray-800 rounded-lg p-2 mb-4">
                <div className="text-gray-500 mb-1">Skipped (duplicates / empty):</div>
                {importResult.skipped.map((s, i) => <div key={i} className="truncate">• {s.name || '(no name)'}{s.phone ? ` · ${s.phone}` : ''} <span className="text-gray-600">({s.reason})</span></div>)}
              </div>
            )}
            <button onClick={() => setImportResult(null)} className="w-full bg-green-600 hover:bg-green-500 text-white text-sm font-semibold py-2.5 rounded-lg">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
