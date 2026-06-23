'use client';

import React, { useEffect, useState, useCallback } from 'react';

type Reply = { text: string; timestamp: string };

type Lead = {
  id: number;
  name: string;
  email: string;
  phone: string;
  created: string;
  notes: string;
  adviser: string;
  sent: boolean;
  sentAt: string | null;
  replies: Reply[];
};

type WaStatus = { state: 'open' | 'connecting' | 'close'; qr: string | null };

const DEFAULT_TEMPLATE = `Hi [Name], We connected previously regarding a business/career opportunity, but I recently switched to WhatsApp Business and lost my chat history.

I'm updating my records and wanted to check if you're still open to hearing about opportunities or additional income streams.

If yes, just reply "Interested" and I'll send you the details. If not, no worries and I won't follow up further.`;

const API = '/api/proxy';

export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState<WaStatus>({ state: 'close', qr: null });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unsent' | 'sent'>('unsent');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [sending, setSending] = useState<Set<number>>(new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [hideNo, setHideNo] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', phone: '', email: '', notes: '', adviser: '' });
  const [addSaving, setAddSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API}/status`);
      const d = await r.json();
      setStatus(d);
    } catch {}
  }, []);

  const fetchLeads = useCallback(async () => {
    try {
      const r = await fetch(`${API}/leads`);
      const d = await r.json();
      setLeads(d);
    } catch {}
  }, []);

  useEffect(() => {
    fetchLeads();
    fetchStatus();
    const iv = setInterval(fetchStatus, 4000);
    return () => clearInterval(iv);
  }, [fetchLeads, fetchStatus]);

  const visible = leads.filter((l) => {
    const matchSearch =
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.phone.includes(search) ||
      l.email.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === 'all' ||
      (filter === 'sent' && l.sent) ||
      (filter === 'unsent' && !l.sent);
    const matchNo = !hideNo || !/\bno\b/i.test(l.notes);
    return matchSearch && matchFilter && matchNo;
  });

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === visible.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visible.map((l) => l.id)));
    }
  };

  const buildMessage = (name: string) =>
    template.replace('[Name]', name);

  const sendOne = async (lead: Lead) => {
    if (status.state !== 'open') return showToast('WhatsApp not connected', false);
    setSending((p) => new Set(p).add(lead.id));
    try {
      const r = await fetch(`${API}/send/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: buildMessage(lead.name) }),
      });
      const d = await r.json();
      if (d.ok) {
        setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, sent: true, sentAt: new Date().toISOString() } : l)));
        showToast(`Sent to ${lead.name}`);
      } else {
        showToast(d.error || 'Failed', false);
      }
    } catch {
      showToast('Network error', false);
    } finally {
      setSending((p) => { const n = new Set(p); n.delete(lead.id); return n; });
    }
  };

  const addLead = async () => {
    if (!addForm.name.trim() || !addForm.phone.trim()) return;
    setAddSaving(true);
    try {
      const r = await fetch(`${API}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      });
      const d = await r.json();
      if (r.ok) {
        setLeads((prev) => [d, ...prev]);
        setAddForm({ name: '', phone: '', email: '', notes: '' });
        setShowAdd(false);
        showToast(`Added ${d.name}`);
      } else {
        showToast(d.error || 'Failed to add', false);
      }
    } catch {
      showToast('Network error', false);
    } finally {
      setAddSaving(false);
    }
  };

  const sendBulk = async () => {
    if (status.state !== 'open') return showToast('WhatsApp not connected', false);
    if (selected.size === 0) return;
    setBulkSending(true);
    try {
      const r = await fetch(`${API}/send/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const d = await r.json();
      const succeeded = d.results?.filter((x: { ok: boolean }) => x.ok).length ?? 0;
      const failed = d.results?.length - succeeded;
      await fetchLeads();
      setSelected(new Set());
      showToast(`Sent ${succeeded}${failed ? `, ${failed} failed` : ''}`);
    } catch {
      showToast('Network error', false);
    } finally {
      setBulkSending(false);
    }
  };

  const sentCount = leads.filter((l) => l.sent).length;

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-green-400">Watapp</span>
          <span className="text-gray-500 text-sm">{leads.length} leads · {sentCount} sent</span>
        </div>

        {/* WA Status */}
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-full border ${
            status.state === 'open'
              ? 'bg-green-950 border-green-700 text-green-300'
              : status.state === 'connecting'
              ? 'bg-yellow-950 border-yellow-700 text-yellow-300'
              : 'bg-gray-900 border-gray-700 text-gray-400'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              status.state === 'open' ? 'bg-green-400' : status.state === 'connecting' ? 'bg-yellow-400 animate-pulse' : 'bg-gray-600'
            }`} />
            {status.state === 'open' ? 'Connected' : status.state === 'connecting' ? 'Scan QR' : 'Disconnected'}
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-72 border-r border-gray-800 flex flex-col gap-6 p-5">
          {/* QR */}
          {status.state !== 'open' && (
            <div className="rounded-xl border border-gray-700 p-4 flex flex-col items-center gap-3">
              <p className="text-xs text-gray-400 text-center">
                {status.qr ? 'Scan with WhatsApp to connect' : 'Waiting for QR code…'}
              </p>
              {status.qr ? (
                <img src={status.qr} alt="QR Code" className="w-48 h-48 rounded-lg" />
              ) : (
                <div className="w-48 h-48 bg-gray-800 rounded-lg animate-pulse" />
              )}
            </div>
          )}

          {/* Template */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Message Template</label>
            <textarea
              className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed"
              rows={12}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
            <p className="text-xs text-gray-500">[Name] is replaced with the full name</p>
          </div>

          {/* Bulk send */}
          {selected.size > 0 && (
            <button
              onClick={sendBulk}
              disabled={bulkSending || status.state !== 'open'}
              className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
            >
              {bulkSending ? 'Sending…' : `Send to ${selected.size} selected`}
            </button>
          )}
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-4">
            <input
              type="text"
              placeholder="Search name, phone, email…"
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1">
              {(['unsent', 'sent', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded text-sm capitalize transition-colors ${
                    filter === f ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <button
              onClick={() => setHideNo((p) => !p)}
              className={`text-sm font-medium px-4 py-2 rounded-lg transition-colors whitespace-nowrap border ${
                hideNo
                  ? 'bg-red-900/60 border-red-700 text-red-300'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {hideNo ? 'Showing: no hidden' : 'Hide "No"'}
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
            >
              + Add Lead
            </button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-950 border-b border-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={visible.length > 0 && selected.size === visible.length}
                      onChange={toggleAll}
                      className="rounded accent-green-500"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">#</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Name</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Phone</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Notes</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Replies</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium">Status</th>
                  <th className="px-4 py-3 text-right text-gray-400 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {visible.map((lead) => (
                  <React.Fragment key={lead.id}>
                  <tr
                    className={`transition-colors ${
                      selected.has(lead.id) ? 'bg-green-950/20' : 'hover:bg-gray-900/50'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                        className="rounded accent-green-500"
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{lead.id}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-100">{lead.name}</div>
                      <div className="text-xs text-gray-500">{lead.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">{lead.phone}</td>
                    <td className="px-4 py-3">
                      {lead.notes && (
                        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{lead.notes}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {lead.replies?.length > 0 ? (
                        <button
                          onClick={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                          className="inline-flex items-center gap-1.5 text-xs bg-blue-900/60 border border-blue-700 text-blue-300 px-2 py-0.5 rounded-full hover:bg-blue-800/60 transition-colors"
                        >
                          <span>💬</span> {lead.replies.length} {lead.replies.length === 1 ? 'reply' : 'replies'}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-700">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {lead.sent ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                          <span>✓</span> Sent
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!lead.sent && (
                        <button
                          onClick={() => sendOne(lead)}
                          disabled={sending.has(lead.id) || status.state !== 'open'}
                          className="text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg transition-colors"
                        >
                          {sending.has(lead.id) ? '…' : 'Send'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === lead.id && lead.replies?.length > 0 && (
                    <tr className="bg-blue-950/20">
                      <td colSpan={8} className="px-8 py-3">
                        <div className="flex flex-col gap-2">
                          {lead.replies.map((r, i) => (
                            <div key={i} className="flex items-start gap-3 text-sm">
                              <span className="text-blue-400 text-xs mt-0.5 whitespace-nowrap">
                                {new Date(r.timestamp).toLocaleString('en-SG', { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                              <span className="text-gray-200">{r.text}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-16 text-center text-gray-600">
                      No leads match your filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      {/* Add Lead Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-100 mb-5">Add Lead</h2>
            <div className="flex flex-col gap-4">
              {[
                { label: 'Name *', key: 'name', placeholder: 'Full name', type: 'text' },
                { label: 'Phone *', key: 'phone', placeholder: 'e.g. 6591234567', type: 'tel' },
                { label: 'Email', key: 'email', placeholder: 'email@example.com', type: 'email' },
                { label: 'Adviser Name', key: 'adviser', placeholder: 'Who referred / added this lead', type: 'text' },
                { label: 'Notes', key: 'notes', placeholder: 'pending, on, etc.', type: 'text' },
              ].map(({ label, key, placeholder, type }) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">{label}</label>
                  <input
                    type={type}
                    placeholder={placeholder}
                    value={addForm[key as keyof typeof addForm]}
                    onChange={(e) => setAddForm((p) => ({ ...p, [key]: e.target.value }))}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-green-600"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowAdd(false)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addLead}
                disabled={addSaving || !addForm.name.trim() || !addForm.phone.trim()}
                className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
              >
                {addSaving ? 'Saving…' : 'Add Lead'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm font-medium shadow-xl transition-all ${
          toast.ok ? 'bg-green-700 text-green-50' : 'bg-red-800 text-red-100'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
