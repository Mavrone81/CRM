'use client';

import React, { useState } from 'react';
import type { Lead, WaNumber } from './types';
import type { Status } from './status';
import { ALL_STATUSES, STATUS_META } from './status';
import { relTime, lastContactOf, lastReplyOf } from './types';
import { API, logReply, sendReply, setStatus, updateLead, reclassify } from './leadApi';
import { COUNTRY_CODES, phoneParts } from './countryCodes';

const GROUPS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'pipeline', label: 'Pipeline' },
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
  const [agentFilter, setAgentFilter] = useState('all');
  const [group, setGroup] = useState('all');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  // Count of leads per status (drives the status-workflow chips).
  const statusCount: Record<string, number> = {};
  leads.forEach((l) => { const s = (l.status || 'new'); statusCount[s] = (statusCount[s] || 0) + 1; });
  const sortBy = (key: string) => setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [convoFor, setConvoFor] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState<Record<number, string>>({}); // editable suggested reply in the chat dropdown
  const [suggesting, setSuggesting] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '', cc: '65' });
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<Lead | null>(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '', assignedNumber: '', cc: '65' });
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

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleSel = (id: number) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const bulk = async (action: string, raw: string) => {
    if (!raw) return; // ignore the disabled placeholder
    const value = raw === '__none__' ? '' : raw;
    const r = await fetch(`${API}/leads/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selected], action, value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { showToast(`Updated ${d.updated} lead(s)`); setSelected(new Set()); refresh(); } else showToast(d.error || 'Failed', false);
  };
  const bulkOutreach = async () => {
    const remaining = numbers.filter((n) => n.state === 'open').reduce((s, n) => s + Math.max(0, (n.cap || 40) - (n.sentToday || 0)), 0);
    const over = selected.size > remaining;
    const msg = `Start paced outreach to ${selected.size} selected lead(s)?\n\n` +
      (over ? `⚠ Only ${remaining} can go out today (combined remaining cap across your numbers). The other ${selected.size - remaining} will wait until caps reset or you raise them.\n\n` : `Within today's capacity — ${remaining} sends remaining.\n\n`) +
      'A varied opening is sent to each, ~20–50s apart.';
    if (!confirm(msg)) return;
    const r = await fetch(`${API}/outreach/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadIds: [...selected] }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { showToast(`Outreach started — ${d.queued} queued`); setSelected(new Set()); } else showToast(d.error || 'Failed', false);
  };

  const numLabel = (id?: string) => numbers.find((n) => n.id === id)?.label || (id ? id : '—');
  const openEdit = (l: Lead) => { setEdit(l); setEditForm({ name: l.name || '', phone: l.phone || '', email: l.email || '', notes: l.notes || '', adviser: l.adviser || '', assignedNumber: (l as Lead & { assignedNumber?: string }).assignedNumber || '', cc: '65' }); };
  const saveEdit = async () => {
    if (!edit) return;
    setSaving(true);
    const { ok, data } = await updateLead(edit.id, { ...editForm, assignedNumber: editForm.assignedNumber || null });
    setSaving(false);
    if (ok && (data.id || data.ok !== false)) { showToast('Lead updated'); setEdit(null); refresh(); } else showToast(data.error || 'Update failed', false);
  };

  const repName = (id?: string) => { const n = numbers.find((x) => x.id === id); return n?.repName || n?.label || ''; };
  const visible = leads.filter((l) => {
    const s = (l.status || 'new') as Status;
    const matchGroup = group === 'all' || STATUS_META[s]?.group === group;
    const matchStatus = statusFilter === 'all' || s === statusFilter;
    const matchAgent = agentFilter === 'all' || (agentFilter === '__none__' ? !l.assignedNumber : l.assignedNumber === agentFilter);
    const q = search.toLowerCase();
    const matchSearch = !q || l.name.toLowerCase().includes(q) || l.phone.includes(search) || (l.email || '').toLowerCase().includes(q);
    return matchGroup && matchStatus && matchAgent && matchSearch;
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
  const suggestChat = async (id: number) => {
    setSuggesting(id);
    try {
      const r = await fetch(`${API}/leads/${id}/suggest`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.suggested_reply) { setChatDraft((p) => ({ ...p, [id]: d.suggested_reply })); showToast('Suggested'); refresh(); }
      else showToast(d.error || 'Could not suggest', false);
    } catch { showToast('Network error', false); } finally { setSuggesting(null); }
  };
  const sendChat = async (id: number, text: string) => {
    if (!text.trim()) return;
    const { ok, data } = await sendReply(id, text);
    if (ok && data.ok !== false) { showToast('Sent'); refresh(); } else showToast(data.error || 'Send failed', false);
  };
  const reclassifyLead = async (id: number, name: string) => {
    const { ok, data } = await reclassify(id) as { ok: boolean; data: { moved?: boolean; from?: string; to?: string; reason?: string; error?: string } };
    if (ok) { showToast(data.moved ? `${name}: ${data.from} → ${data.to}` : `${name}: no change — ${data.reason || 'looks right'}`); refresh(); }
    else showToast(data.error || 'Failed', false);
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
    if (r.ok) { showToast(`Added ${addForm.name}`); setAddForm({ name: '', phone: '', email: '', notes: '', adviser: '', cc: '65' }); setShowAdd(false); refresh(); }
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
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent" className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-green-600">
          <option value="all">All agents</option>
          {numbers.map((n) => <option key={n.id} value={n.id}>{n.repName || n.label}</option>)}
          <option value="__none__">Unassigned</option>
        </select>
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

      {selected.size > 0 && (
        <div className="px-4 sm:px-6 py-2 border-b border-gray-800 bg-gray-900/70 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-200 font-medium whitespace-nowrap">{selected.size} selected</span>
          <select defaultValue="" onChange={(e) => { bulk('status', e.target.value); e.target.value = ''; }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 focus:outline-none focus:border-green-600">
            <option value="" disabled>Set status…</option>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
          <select defaultValue="" onChange={(e) => { bulk('assign', e.target.value); e.target.value = ''; }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 focus:outline-none focus:border-green-600">
            <option value="" disabled>Assign number…</option>
            <option value="__none__">— none / auto —</option>
            {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
          <button onClick={bulkOutreach} className="bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded-lg font-medium whitespace-nowrap">Start outreach</button>
          <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-gray-200 px-2 py-1.5 ml-auto">Clear</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-950 border-b border-gray-800">
            <tr>
              <th className="pl-3 sm:pl-4 py-3 w-8"><input type="checkbox" checked={sorted.length > 0 && sorted.every((l) => selected.has(l.id))} onChange={(e) => setSelected((p) => { const n = new Set(p); if (e.target.checked) sorted.forEach((l) => n.add(l.id)); else sorted.forEach((l) => n.delete(l.id)); return n; })} className="align-middle cursor-pointer" /></th>
              <th onClick={() => sortBy('name')} className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium cursor-pointer hover:text-gray-200 select-none">Name{arrow('name')}</th>
              <th className="px-2 py-3 text-left text-gray-400 font-medium">Country</th>
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
              const ph = phoneParts(l.phone);
              return (
                <React.Fragment key={l.id}>
                  <tr className={`hover:bg-gray-900/50 ${selected.has(l.id) ? 'bg-gray-900/40' : ''}`}>
                    <td className="pl-3 sm:pl-4 py-3 w-8"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSel(l.id)} className="align-middle cursor-pointer" /></td>
                    <td className="px-3 sm:px-4 py-3">
                      <div className="font-medium text-gray-100 flex items-center gap-1.5">{l.name}{l.needsReply && <span className="text-[10px] px-1.5 rounded-full bg-blue-900 border border-blue-700 text-blue-200">new</span>}</div>
                      <div className="text-xs text-gray-500 truncate max-w-[160px] sm:max-w-none">{l.email}</div>
                    </td>
                    <td className="px-2 py-3 text-xs whitespace-nowrap">
                      {ph.flag ? <span className="inline-flex items-center gap-1"><span>{ph.flag}</span><span className="text-gray-400">{ph.iso || `+${ph.cc}`}</span></span> : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-xs whitespace-nowrap">
                      <div className="text-gray-300 font-mono">{ph.local || '—'}</div>
                      <div className="text-[10px] text-gray-500">{l.channel === 'telegram' ? '✈ Telegram' : (repName(l.assignedNumber) ? `👤 ${repName(l.assignedNumber)}` : `📱 ${numLabel(l.assignedNumber)}`)}</div>
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
                      <button onClick={() => setConvoFor(convoFor === l.id ? null : l.id)} className="text-xs text-gray-400 hover:text-gray-200 mr-3">{convoFor === l.id ? '▾ Chat' : '▸ Chat'}</button>
                      <button onClick={() => reclassifyLead(l.id, l.name)} title="Bot re-reads the chat and updates the stage" className="text-xs text-purple-300 hover:text-purple-200 mr-3">🔄</button>
                      <button onClick={() => openEdit(l)} className="text-xs text-gray-400 hover:text-gray-200 mr-3">Edit</button>
                      <button onClick={() => { setReplyFor(replyFor === l.id ? null : l.id); setReplyText(''); }} className="text-xs text-gray-400 hover:text-gray-200 mr-3">Log reply</button>
                      <button onClick={async () => { if (!confirm(`Confirm remove? ${l.name} will be permanently deleted.`)) return; const r = await fetch(`${API}/leads/${l.id}`, { method: 'DELETE' }); if (r.ok) { showToast('Lead removed'); refresh(); } else showToast('Remove failed', false); }} className="text-xs text-red-500 hover:text-red-400">Remove</button>
                    </td>
                  </tr>
                  {replyFor === l.id && (
                    <tr className="bg-gray-900/40"><td colSpan={7} className="px-4 py-2">
                      <div className="flex gap-2">
                        <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder={`What ${l.name} said…`} autoFocus className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                        <button onClick={async () => { if (!replyText.trim()) return; const { ok } = await logReply(l.id, replyText.trim()); if (ok) { showToast('Reply logged + classified'); setReplyFor(null); refresh(); } }} className="bg-blue-700 hover:bg-blue-600 text-white text-sm px-3 py-2 rounded-lg">Save</button>
                      </div>
                    </td></tr>
                  )}
                  {convoFor === l.id && (
                    <tr className="bg-gray-950/60"><td colSpan={7} className="px-3 sm:px-4 py-3">
                      {(() => {
                        const thread = [
                          ...(l.replies || []).map((r) => ({ text: r.text, ts: r.timestamp, dir: 'in' as const, via: (r as { via?: string }).via })),
                          ...(l.sentReplies || []).map((r) => ({ text: r.text, ts: r.timestamp, dir: 'out' as const, via: (r as { via?: string }).via })),
                        ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
                        return (
                          <div className="flex flex-col gap-2">
                            {thread.length === 0 ? <div className="text-xs text-gray-600">No messages yet.</div> : (
                              <div className="flex flex-col gap-1.5 max-h-80 overflow-auto">
                                {thread.map((m, i) => (
                                  <div key={i} className={`max-w-[85%] break-words [overflow-wrap:anywhere] rounded-2xl px-3 py-1.5 text-sm ${m.dir === 'out' ? 'self-end bg-green-900/40 text-green-50 rounded-br-sm' : 'self-start bg-gray-800 text-gray-200 rounded-bl-sm'}`}>
                                    {m.text}
                                    <span className="block text-[10px] text-gray-500 mt-0.5">{m.dir === 'out' ? 'agent' : l.name}{m.via ? ` · ${numLabel(m.via)}` : ''} · {relTime(m.ts)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* AI-suggested reply — editable, regenerate, send */}
                            {(l.ai?.suggested_reply || chatDraft[l.id] !== undefined) ? (() => {
                              const val = chatDraft[l.id] ?? l.ai?.suggested_reply ?? '';
                              return (
                                <div className="flex flex-col gap-1.5 bg-gray-950/70 border border-gray-800 rounded-lg p-2 max-w-2xl">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-purple-300">Suggested reply <span className="text-gray-600">· editable</span></span>
                                    <button onClick={() => suggestChat(l.id)} disabled={suggesting === l.id} className="text-[11px] text-purple-300 hover:text-purple-200 disabled:opacity-50">{suggesting === l.id ? '…' : '✨ Regenerate'}</button>
                                  </div>
                                  <textarea value={val} onChange={(e) => setChatDraft((p) => ({ ...p, [l.id]: e.target.value }))} rows={3} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 resize-none focus:outline-none focus:border-green-600" />
                                  <div className="flex gap-2">
                                    <button onClick={() => sendChat(l.id, val)} disabled={!val.trim()} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg">Send</button>
                                    <button onClick={() => { navigator.clipboard.writeText(val); showToast('Copied'); }} className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5">Copy</button>
                                  </div>
                                </div>
                              );
                            })() : (
                              <button onClick={() => suggestChat(l.id)} disabled={suggesting === l.id} className="self-start text-xs text-purple-300 hover:text-purple-200 border border-purple-900/50 rounded-lg px-2.5 py-1 disabled:opacity-50">{suggesting === l.id ? 'Generating…' : '✨ Suggest a reply'}</button>
                            )}
                          </div>
                        );
                      })()}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={7} className="px-4 py-16 text-center text-gray-600">No leads match.</td></tr>}
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
                  {key === 'phone' ? (
                    <div className="flex gap-2">
                      <select value={addForm.cc} onChange={(e) => setAddForm((p) => ({ ...p, cc: e.target.value }))} className="w-28 shrink-0 min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg px-2 text-sm text-gray-200 focus:outline-none focus:border-green-600">{COUNTRY_CODES.map((c) => <option key={c.code + c.name} value={c.code}>+{c.code} {c.flag} {c.name}</option>)}</select>
                      <input value={addForm.phone} onChange={(e) => setAddForm((p) => ({ ...p, phone: e.target.value }))} placeholder="9123 4567" className="flex-1 min-w-0 min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg px-3 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                    </div>
                  ) : (
                    <input value={addForm[key]} onChange={(e) => setAddForm((p) => ({ ...p, [key]: e.target.value }))} className="min-h-[44px] bg-gray-800 border border-gray-700 rounded-lg px-3 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                  )}
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
            {(edit as Lead & { wf?: { signed?: { lastFile?: string } } }).wf?.signed?.lastFile && (
              <a href={`${API}/leads/${edit.id}/signed`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 mb-4 text-sm text-cyan-300 hover:text-cyan-200 border border-cyan-900/50 rounded-lg px-3 py-2">📄 Download signed agreement</a>
            )}
            <div className="flex flex-col gap-4">
              {([['Name', 'name'], ['Phone', 'phone'], ['Email', 'email'], ['Adviser', 'adviser'], ['Notes', 'notes']] as const).map(([label, key]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">{label}{key === 'phone' ? ' (include country code, or pick one)' : ''}</label>
                  {key === 'phone' ? (
                    <div className="flex gap-2">
                      <select value={editForm.cc} onChange={(e) => setEditForm((p) => ({ ...p, cc: e.target.value }))} className="w-28 shrink-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600">{COUNTRY_CODES.map((c) => <option key={c.code + c.name} value={c.code}>+{c.code} {c.flag} {c.name}</option>)}</select>
                      <input value={editForm.phone} onChange={(e) => setEditForm((p) => ({ ...p, phone: e.target.value }))} className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                    </div>
                  ) : (
                    <input value={editForm[key]} onChange={(e) => setEditForm((p) => ({ ...p, [key]: e.target.value }))} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                  )}
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
