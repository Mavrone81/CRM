'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Reply = { text: string; timestamp: string };

type AiResult = {
  category: 'interested' | 'not_interested' | 'question' | 'other';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggested_reply: string;
  classifiedAt: string;
};

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
  ai?: AiResult;
};

type WaStatus = { state: 'open' | 'connecting' | 'close'; qr: string | null; ai?: boolean; autoReply?: boolean };

const DEFAULT_TEMPLATE = `Hi [Name], We connected previously regarding a business/career opportunity, but I recently switched to WhatsApp Business and lost my chat history.

I'm updating my records and wanted to check if you're still open to hearing about opportunities or additional income streams.

If yes, just reply "Interested" and I'll send you the details. If not, no worries and I won't follow up further.`;

const API = '/api/proxy';

export default function Dashboard() {
  const router = useRouter();
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
  const [classifying, setClassifying] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [collapseAll, setCollapseAll] = useState(false);
  const [view, setView] = useState<'leads' | 'replies'>('leads');
  const [replyFilter, setReplyFilter] = useState<'all' | 'interested' | 'not' | 'question' | 'other'>('all');

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
    const iv = setInterval(() => {
      fetchStatus();
      fetchLeads(); // poll leads so new replies appear live
    }, 2000);
    return () => clearInterval(iv);
  }, [fetchLeads, fetchStatus]);

  // Keyword fallback only used when the server hasn't classified yet
  const classifyReply = (text: string): 'interested' | 'not' | 'question' | 'other' => {
    const t = text.toLowerCase();
    if (/\b(not interested|no thanks|no thank|stop|unsubscribe|remove me|don'?t|leave me)\b/.test(t)) return 'not';
    if (/\b(interested|yes|yep|yeah|sure|ok|okay|keen|tell me|more info|details|how|sounds good|i'?m in)\b/.test(t)) return 'interested';
    if (/^\s*no\s*$/.test(t)) return 'not';
    if (/\?/.test(t)) return 'question';
    return 'other';
  };

  // Map the server's AI category to the UI's category buckets
  const aiToCategory = (c: AiResult['category']): 'interested' | 'not' | 'question' | 'other' =>
    c === 'not_interested' ? 'not' : c;

  // Leads that have at least one reply, newest reply first
  const repliedLeads = leads
    .filter((l) => l.replies?.length > 0)
    .map((l) => {
      const last = l.replies[l.replies.length - 1];
      const category = l.ai ? aiToCategory(l.ai.category) : classifyReply(last.text);
      return { lead: l, last, category };
    })
    .sort((a, b) => new Date(b.last.timestamp).getTime() - new Date(a.last.timestamp).getTime());

  const replyCount = repliedLeads.length;
  const interestedCount = repliedLeads.filter((r) => r.category === 'interested').length;

  const visibleReplies = repliedLeads.filter(
    (r) => replyFilter === 'all' || r.category === replyFilter
  );

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

  const [sendingReply, setSendingReply] = useState<Set<number>>(new Set());

  const sendSuggestedReply = async (lead: Lead) => {
    const message = lead.ai?.suggested_reply?.trim();
    if (!message) return;
    if (status.state !== 'open') return showToast('WhatsApp not connected', false);
    setSendingReply((p) => new Set(p).add(lead.id));
    try {
      const r = await fetch(`${API}/reply/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const d = await r.json();
      if (d.ok) showToast(`Reply sent to ${lead.name}`);
      else showToast(d.error || 'Send failed', false);
    } catch {
      showToast('Network error', false);
    } finally {
      setSendingReply((p) => { const n = new Set(p); n.delete(lead.id); return n; });
    }
  };

  const classifyLead = async (id: number) => {
    setClassifying((p) => new Set(p).add(id));
    try {
      const r = await fetch(`${API}/classify/${id}`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ai: d.ai } : l)));
      } else {
        showToast(d.error || 'Classification failed', false);
      }
    } catch {
      showToast('Network error', false);
    } finally {
      setClassifying((p) => { const n = new Set(p); n.delete(id); return n; });
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
        setAddForm({ name: '', phone: '', email: '', notes: '', adviser: '' });
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

  const toggleBot = async () => {
    const next = !status.autoReply;
    try {
      const r = await fetch(`${API}/autoreply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (d.ok) {
        setStatus((s) => ({ ...s, autoReply: d.autoReply }));
        showToast(d.autoReply ? 'Bot auto-reply ON' : 'Switched to manual replies');
      }
    } catch {
      showToast('Network error', false);
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
          <span className="text-xl sm:text-2xl font-bold text-green-400">Watapp</span>
          <span className="text-gray-500 text-xs sm:text-sm">{leads.length} leads · {sentCount} sent</span>

          {/* View toggle */}
          <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1 sm:ml-2">
            <button
              onClick={() => setView('leads')}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                view === 'leads' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Leads
            </button>
            <button
              onClick={() => setView('replies')}
              className={`px-3 py-1 rounded text-sm transition-colors inline-flex items-center gap-1.5 ${
                view === 'replies' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Replies
              {replyCount > 0 && (
                <span className="bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
                  {replyCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Bot mode + WA Status */}
        <div className="flex items-center gap-2 sm:gap-3">
          {status.ai && (
            <button
              onClick={toggleBot}
              title={status.autoReply ? 'Bot is auto-replying — click to switch to manual' : 'Manual mode — click to let the bot auto-reply'}
              className={`inline-flex items-center gap-2 text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border transition-colors ${
                status.autoReply
                  ? 'bg-purple-950 border-purple-600 text-purple-200 hover:bg-purple-900'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>{status.autoReply ? '🤖' : '✋'}</span>
              <span className="hidden sm:inline">{status.autoReply ? 'Bot: Auto' : 'Manual'}</span>
              <span className="sm:hidden">{status.autoReply ? 'Auto' : 'Man'}</span>
            </button>
          )}
          <span className={`inline-flex items-center gap-2 text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border ${
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
          <button
            onClick={logout}
            title="Sign out"
            className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
        {/* Sidebar */}
        <aside className="w-full md:w-72 border-b md:border-b-0 md:border-r border-gray-800 flex flex-col gap-6 p-5 md:shrink-0">
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
            <div className="flex flex-col gap-2">
              <button
                onClick={sendBulk}
                disabled={bulkSending || status.state !== 'open'}
                className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
              >
                {bulkSending ? 'Sending…' : `Send to ${selected.size} selected`}
              </button>
              <p className="text-xs text-gray-500 text-center">
                {(() => {
                  const n = selected.size;
                  const batches = Math.ceil(n / 40);
                  const msgMins = Math.round(n * 11.5 / 60);
                  const pauseMins = (batches - 1) * 0.5;
                  const total = msgMins + pauseMins;
                  return `~${total} min · ${batches} batch${batches > 1 ? `es · 30s pause between` : ''}`;
                })()}
              </p>
            </div>
          )}
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col min-h-0 md:overflow-hidden">
          {view === 'replies' ? (
          <>
            {/* Replies toolbar */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
              <h2 className="text-base sm:text-lg font-semibold text-gray-100">Replies Inbox</h2>
              <span className="text-xs sm:text-sm text-gray-500">{interestedCount} interested · {replyCount} total</span>
              {visibleReplies.length > 0 && (
                <button
                  onClick={() => {
                    const allCollapsed = visibleReplies.every((r) => collapsed.has(r.lead.id));
                    setCollapsed(allCollapsed ? new Set() : new Set(visibleReplies.map((r) => r.lead.id)));
                  }}
                  className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded-lg border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200 whitespace-nowrap"
                >
                  {visibleReplies.every((r) => collapsed.has(r.lead.id)) ? 'Expand all' : 'Collapse all'}
                </button>
              )}
              <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1 w-full sm:w-auto sm:ml-auto overflow-x-auto">
                {([
                  { key: 'all', label: 'All' },
                  { key: 'interested', label: 'Interested' },
                  { key: 'question', label: 'Questions' },
                  { key: 'not', label: 'Not interested' },
                  { key: 'other', label: 'Other' },
                ] as const).map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setReplyFilter(f.key)}
                    className={`px-3 py-1 rounded text-sm transition-colors ${
                      replyFilter === f.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Replies list */}
            <div className="flex-1 overflow-auto p-4 sm:p-6 flex flex-col gap-3">
              {visibleReplies.length === 0 && (
                <div className="text-center text-gray-600 py-16">
                  {replyCount === 0 ? 'No replies yet. They appear here automatically when leads respond.' : 'No replies in this category.'}
                </div>
              )}
              {visibleReplies.map(({ lead, last, category }) => {
                const catLabel =
                  category === 'interested' ? '✓ Interested'
                  : category === 'not' ? '✕ Not interested'
                  : category === 'question' ? '? Question'
                  : 'Other';
                const catChip =
                  category === 'interested' ? 'bg-green-900 text-green-300'
                  : category === 'not' ? 'bg-red-900 text-red-300'
                  : category === 'question' ? 'bg-yellow-900 text-yellow-300'
                  : 'bg-gray-800 text-gray-400';
                const isCollapsed = collapsed.has(lead.id);
                const toggleCollapse = () => setCollapsed((p) => {
                  const n = new Set(p); n.has(lead.id) ? n.delete(lead.id) : n.add(lead.id); return n;
                });
                return (
                <div
                  key={lead.id}
                  className={`rounded-xl border p-4 ${
                    category === 'interested'
                      ? 'border-green-700/60 bg-green-950/20'
                      : category === 'not'
                      ? 'border-red-800/50 bg-red-950/10'
                      : category === 'question'
                      ? 'border-yellow-800/40 bg-yellow-950/10'
                      : 'border-gray-700 bg-gray-900/40'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <button
                          onClick={toggleCollapse}
                          className="text-gray-500 hover:text-gray-200 text-xs w-4 shrink-0"
                          title={isCollapsed ? 'Expand' : 'Collapse'}
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                        <span className="font-medium text-gray-100 cursor-pointer" onClick={toggleCollapse}>{lead.name}</span>
                        <span className="text-xs text-gray-500 font-mono">{lead.phone}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${catChip}`}>{catLabel}</span>
                        {lead.ai ? (
                          <span className="text-xs text-purple-300 bg-purple-950/50 border border-purple-800 px-2 py-0.5 rounded-full">
                            AI · {lead.ai.confidence}
                          </span>
                        ) : (
                          <button
                            onClick={() => classifyLead(lead.id)}
                            disabled={classifying.has(lead.id)}
                            className="text-xs text-gray-400 bg-gray-800 hover:bg-gray-700 px-2 py-0.5 rounded-full disabled:opacity-50"
                          >
                            {classifying.has(lead.id) ? 'Analysing…' : 'Classify with AI'}
                          </button>
                        )}
                        {isCollapsed && lead.replies.length > 0 && (
                          <span className="text-xs text-gray-500 truncate max-w-[180px]">— {lead.replies[lead.replies.length - 1].text}</span>
                        )}
                      </div>
                      {!isCollapsed && lead.ai?.reason && (
                        <p className="text-xs text-gray-400 mb-2 italic">{lead.ai.reason}</p>
                      )}
                      {!isCollapsed && (
                      <div className="flex flex-col gap-1.5 mt-2">
                        {lead.replies.map((r, i) => (
                          <div key={i} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-sm">
                            <span className="text-gray-200 bg-gray-800 rounded-lg px-3 py-1.5 inline-block min-w-0 break-words max-w-full">{r.text}</span>
                            <span className="text-xs text-gray-600 mt-2 whitespace-nowrap">
                              {new Date(r.timestamp).toLocaleString('en-SG', { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                          </div>
                        ))}
                      </div>
                      )}
                      {!isCollapsed && lead.ai?.suggested_reply && (
                        <div className="mt-3 flex flex-wrap items-start gap-2 bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
                          <span className="text-xs text-purple-300 mt-0.5 whitespace-nowrap">Suggested:</span>
                          <span className="text-sm text-gray-300 flex-1 min-w-[60%] break-words">{lead.ai.suggested_reply}</span>
                          <button
                            onClick={() => { navigator.clipboard.writeText(lead.ai!.suggested_reply); showToast('Reply copied'); }}
                            className="text-xs text-gray-400 hover:text-gray-200 whitespace-nowrap"
                          >
                            Copy
                          </button>
                          <button
                            onClick={() => sendSuggestedReply(lead)}
                            disabled={sendingReply.has(lead.id) || status.state !== 'open'}
                            className="text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-md whitespace-nowrap"
                          >
                            {sendingReply.has(lead.id) ? 'Sending…' : 'Send'}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-row sm:flex-col gap-2 shrink-0">
                      <a
                        href={`https://wa.me/${lead.phone.replace(/\D/g, '').length === 8 ? '65' + lead.phone.replace(/\D/g, '') : lead.phone.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap text-center"
                      >
                        Open chat
                      </a>
                      {lead.ai && (
                        <button
                          onClick={() => classifyLead(lead.id)}
                          disabled={classifying.has(lead.id)}
                          className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg disabled:opacity-50 whitespace-nowrap"
                        >
                          {classifying.has(lead.id) ? '…' : 'Re-run AI'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </>
          ) : (
          <>
          {/* Toolbar */}
          <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-2 sm:gap-4">
            <input
              type="text"
              placeholder="Search name, phone, email…"
              className="w-full sm:flex-1 sm:w-auto bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600"
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
                  <th className="px-3 sm:px-4 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={visible.length > 0 && selected.size === visible.length}
                      onChange={toggleAll}
                      className="rounded accent-green-500"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium hidden sm:table-cell">#</th>
                  <th className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium">Name</th>
                  <th className="px-3 sm:px-4 py-3 text-left text-gray-400 font-medium">Phone</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium hidden md:table-cell">Notes</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium hidden sm:table-cell">Replies</th>
                  <th className="px-4 py-3 text-left text-gray-400 font-medium hidden sm:table-cell">Status</th>
                  <th className="px-3 sm:px-4 py-3 text-right text-gray-400 font-medium">Action</th>
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
                    <td className="px-3 sm:px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                        className="rounded accent-green-500"
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs hidden sm:table-cell">{lead.id}</td>
                    <td className="px-3 sm:px-4 py-3">
                      <div className="font-medium text-gray-100">{lead.name}</div>
                      <div className="text-xs text-gray-500 truncate max-w-[160px] sm:max-w-none">{lead.email}</div>
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-gray-300 font-mono text-xs whitespace-nowrap">{lead.phone}</td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {lead.notes && (
                        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{lead.notes}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
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
                    <td className="px-4 py-3 hidden sm:table-cell">
                      {lead.sent ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                          <span>✓</span> Sent
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-right">
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
          </>
          )}
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
