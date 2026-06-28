'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Lead, WaStatus } from './types';
import Analytics from './Analytics';
import Inbox from './Inbox';
import Pipeline from './Pipeline';
import Directory from './Directory';
import Settings from './Settings';
import Numbers from './Numbers';

const API = '/api/proxy';
type View = 'inbox' | 'pipeline' | 'directory' | 'analytics';

export default function Dashboard() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [status, setStatus] = useState<WaStatus>({ state: 'close', qr: null });
  const [view, setView] = useState<View>('directory');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [showWa, setShowWa] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const showToast = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  // Only re-render when the polled data actually changed (keeps open menus / typing stable).
  const leadsSig = useRef(''); const statusSig = useRef('');
  const fetchLeads = useCallback(async () => {
    try { const d = await (await fetch(`${API}/leads`)).json(); const sig = JSON.stringify(d); if (sig !== leadsSig.current) { leadsSig.current = sig; setLeads(d); } } catch {}
  }, []);
  const fetchStatus = useCallback(async () => {
    try { const d = await (await fetch(`${API}/status`)).json(); const sig = JSON.stringify(d); if (sig !== statusSig.current) { statusSig.current = sig; setStatus(d); } } catch {}
  }, []);

  useEffect(() => {
    fetchLeads(); fetchStatus();
    const iv = setInterval(() => { fetchStatus(); fetchLeads(); }, 2500);
    return () => clearInterval(iv);
  }, [fetchLeads, fetchStatus]);

  const logout = async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {} router.replace('/login'); router.refresh(); };

  const inboxCount = leads.filter((l) => l.status === 'question' || l.status === 'review' || l.status === 'new').length;
  const newLeadCount = leads.filter((l) => l.status === 'new' && l.channel !== 'telegram').length;
  const pipelineCount = leads.filter((l) => l.status && !['new', 'contacted', 'question', 'review', 'declined', 'opted_out'].includes(l.status)).length;
  const sentCount = leads.filter((l) => l.sent).length;

  const tabs: { key: View; label: string; badge?: number }[] = [
    { key: 'directory', label: 'Directory' },
    { key: 'inbox', label: 'Inbox', badge: inboxCount },
    { key: 'pipeline', label: 'Pipeline', badge: pipelineCount },
    { key: 'analytics', label: 'Analytics' },
  ];

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-30 bg-gray-950/90 backdrop-blur border-b border-gray-800 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
          <span className="text-xl sm:text-2xl font-bold text-green-400">Watapp</span>
          <span className="text-gray-500 text-xs sm:text-sm">{leads.length} leads · {sentCount} sent</span>
          <div className="flex gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1 sm:ml-2 max-w-full overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setView(t.key)} className={`px-3 py-1 rounded text-sm whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${view === t.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {t.label}
                {t.badge ? <span className={`text-xs px-1.5 py-0.5 rounded-full ${t.key === 'inbox' ? 'bg-blue-600' : 'bg-purple-600'} text-white min-w-5 text-center`}>{t.badge}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => setShowWa(true)} title="Manage WhatsApp connection" className={`inline-flex items-center gap-2 text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border cursor-pointer hover:opacity-80 ${status.state === 'open' ? 'bg-green-950 border-green-700 text-green-300' : status.state === 'connecting' ? 'bg-yellow-950 border-yellow-700 text-yellow-300' : 'bg-gray-900 border-gray-700 text-gray-400'}`}>
            <span className={`w-2 h-2 rounded-full ${status.state === 'open' ? 'bg-green-400' : status.state === 'connecting' ? 'bg-yellow-400 animate-pulse' : 'bg-gray-600'}`} />
            {status.state === 'open' ? 'Connected' : status.state === 'connecting' ? 'Scan QR' : 'Disconnected'}
          </button>
          <button onClick={() => setShowSettings(true)} title="Settings" className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">⚙</button>
          <button onClick={logout} className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded-full border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">Sign out</button>
        </div>
      </header>

      <div className="flex flex-col flex-1 md:overflow-hidden">
        {view === 'inbox' && <Inbox leads={leads} numbers={status.numbers || []} showToast={showToast} refresh={fetchLeads} />}
        {view === 'pipeline' && <Pipeline leads={leads} status={status} showToast={showToast} refresh={fetchLeads} />}
        {view === 'directory' && <Directory leads={leads} numbers={status.numbers || []} showToast={showToast} refresh={fetchLeads} />}
        {view === 'analytics' && <Analytics leads={leads} />}
      </div>

      {showWa && <Numbers numbers={status.numbers || []} outreach={status.outreach} newLeadCount={newLeadCount} onClose={() => setShowWa(false)} showToast={showToast} refresh={fetchStatus} />}

      {showSettings && <Settings onClose={() => setShowSettings(false)} showToast={showToast} />}

      {toast && <div className={`fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 max-w-sm sm:max-w-md px-4 py-3 rounded-xl text-sm font-medium shadow-xl break-words ${toast.ok ? 'bg-green-700 text-green-50' : 'bg-red-800 text-red-100'}`}>{toast.msg}</div>}
    </div>
  );
}
