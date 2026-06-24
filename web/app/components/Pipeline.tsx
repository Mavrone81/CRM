'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { Lead, WaStatus, Config, DocMeta, Stage, Session } from './types';

const fmtDate = (d?: string) => {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
};
const sessionText = (s: Session) => (s.date ? `${s.label} · ${fmtDate(s.date)}` : s.label);

const API = '/api/proxy';

async function post(path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

type Props = {
  leads: Lead[];
  status: WaStatus;
  showToast: (msg: string, ok?: boolean) => void;
  refresh: () => void;
};

const COLUMNS: { key: Stage; title: string; hint: string }[] = [
  { key: 'brief', title: 'Brief', hint: 'Invite to briefing' },
  { key: 'confirmed', title: 'Confirmed', hint: 'Assign a session' },
  { key: 'slotted', title: 'Slotted', hint: 'Take attendance' },
  { key: 'attended', title: 'Attended', hint: 'Send agreement' },
  { key: 'agreement_sent', title: 'Agreement', hint: 'Bot auto-validates the returned signed PDF' },
  { key: 'onboarding', title: 'Onboarding', hint: 'Bot offers sessions; lead replies to pick (auto)' },
  { key: 'onboarding_slotted', title: 'Booked', hint: 'Take onboarding-session attendance' },
  { key: 'onboarded', title: 'On-board', hint: 'Sales Reps ✅' },
];

// All stages a card can be manually moved to.
const MOVE_TARGETS: { value: string; label: string }[] = [
  { value: 'inbox', label: 'Inbox (remove)' },
  { value: 'brief', label: 'Brief' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'slotted', label: 'Slotted' },
  { value: 'attended', label: 'Attended' },
  { value: 'agreement_sent', label: 'Agreement Sent' },
  { value: 'declined', label: 'Declined' },
];

export default function Pipeline({ leads, status, showToast, refresh }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [inviteFor, setInviteFor] = useState<number | null>(null);
  const [inviteText, setInviteText] = useState('');
  const [settingsTab, setSettingsTab] = useState<null | 'brief' | 'sessions' | 'onboarding' | 'documents'>(null);
  const [activeStage, setActiveStage] = useState<Stage>('brief');

  const loadConfig = useCallback(async () => {
    try { setConfig(await (await fetch(`${API}/config`)).json()); } catch {}
  }, []);
  const loadDocs = useCallback(async () => {
    try { setDocs(await (await fetch(`${API}/documents`)).json()); } catch {}
  }, []);
  useEffect(() => { loadConfig(); loadDocs(); }, [loadConfig, loadDocs]);

  const mark = (k: string, on: boolean) =>
    setBusy((p) => { const n = new Set(p); on ? n.add(k) : n.delete(k); return n; });

  const act = async (key: string, path: string, body: unknown, okMsg: string) => {
    mark(key, true);
    try {
      const { ok, data } = await post(path, body);
      if (ok && data.ok !== false) { showToast(okMsg); refresh(); }
      else showToast(data.error || 'Action failed', false);
    } catch { showToast('Network error', false); }
    finally { mark(key, false); }
  };

  const requireConn = () => {
    if (status.state !== 'open') { showToast('WhatsApp not connected', false); return false; }
    return true;
  };

  // ── Column membership ──────────────────────────────────────────────────────────
  const inBrief = (l: Lead) => l.stage === 'brief' || (!l.stage && l.ai?.category === 'interested');
  const colLeads: Record<Stage, Lead[]> = {
    brief: leads.filter(inBrief),
    confirmed: leads.filter((l) => l.stage === 'confirmed'),
    slotted: leads.filter((l) => l.stage === 'slotted'),
    attended: leads.filter((l) => l.stage === 'attended'),
    agreement_sent: leads.filter((l) => l.stage === 'agreement_sent'),
    onboarding: leads.filter((l) => l.stage === 'onboarding'),
    onboarding_slotted: leads.filter((l) => l.stage === 'onboarding_slotted'),
    onboarded: leads.filter((l) => l.stage === 'onboarded'),
    declined: [],
  };
  const activeCol = COLUMNS.find((c) => c.key === activeStage);

  const sessionLabel = (id?: string | null) => {
    const s = config?.sessions.find((x) => x.id === id);
    return s ? sessionText(s) : id || '—';
  };
  const sessionsBlock = () => (config?.sessions || []).map((s) => `• ${sessionText(s)}`).join('\n');
  const onbLabel = (id?: string | null) => {
    const s = config?.onboardingSessions.find((x) => x.id === id);
    return s ? sessionText(s) : id || '—';
  };
  const fmtDateTime = (d?: string) => (d ? new Date(d).toLocaleString('en-SG', { dateStyle: 'short', timeStyle: 'short' }) : '');
  // Count people already assigned to each session (slotted onward).
  const sessionCounts: Record<string, number> = {};
  leads.forEach((l) => {
    if (l.wf?.session && ['slotted', 'attended', 'agreement_sent'].includes(l.stage || ''))
      sessionCounts[l.wf.session] = (sessionCounts[l.wf.session] || 0) + 1;
  });

  const lastReply = (l: Lead) => l.replies?.[l.replies.length - 1];
  const defaultDoc = docs.find((d) => d.isDefault) || docs[0];

  const openInvite = (l: Lead) => {
    const tmpl = config?.briefTemplate || 'Hi [Name],';
    let msg = tmpl.replace(/\[Name\]/g, l.name);
    const block = sessionsBlock();
    // Always integrate the dated session list: replace the [Sessions] token if
    // present, otherwise append it so sessions are never left out of the invite.
    if (msg.includes('[Sessions]')) msg = msg.replace(/\[Sessions\]/g, block);
    else if (block) msg += `\n\nUpcoming sessions:\n${block}`;
    setInviteText(msg);
    setInviteFor(l.id);
  };

  // ── Card ───────────────────────────────────────────────────────────────────────
  // Rendered as a plain function (NOT <Card/>) so the 2s leads poll re-renders
  // cards in place instead of remounting them — otherwise open <select> dropdowns
  // and the invite composer would reset every poll tick.
  const renderCard = (lead: Lead, col: Stage) => {
    const lr = lastReply(lead);
    const conf = lead.wf?.confirmation;
    const invited = !!lead.wf?.invitedAt;
    const b = (k: string) => busy.has(`${k}:${lead.id}`);
    return (
      <div key={lead.id} className="rounded-xl border border-gray-700 bg-gray-900/50 p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-100 text-sm">{lead.name}</span>
          <span className="text-xs text-gray-500 font-mono">{lead.phone}</span>
          {lead.role === 'potential_onboard' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-950 border border-teal-800 text-teal-300">Potential on-board</span>}
          {lead.role === 'onboard' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900 border border-green-700 text-green-200">Sales Rep</span>}
        </div>
        {lr && (
          <p className="text-xs text-gray-400 bg-gray-800/60 rounded-lg px-2 py-1.5 line-clamp-3">“{lr.text}”</p>
        )}

        {/* Brief column */}
        {col === 'brief' && (
          <>
            {invited && (
              <span className="text-xs text-blue-300 bg-blue-950/40 border border-blue-800 rounded-full px-2 py-0.5 w-fit">✓ Invited</span>
            )}
            {conf && (
              <div className={`text-xs rounded-lg px-2 py-1.5 border ${
                conf.status === 'confirmed' ? 'border-green-700 bg-green-950/30 text-green-300'
                : conf.status === 'declined' ? 'border-red-800 bg-red-950/20 text-red-300'
                : 'border-yellow-800 bg-yellow-950/20 text-yellow-300'}`}>
                AI: {conf.status} · {conf.confidence}
                <span className="block text-gray-400 mt-0.5 italic">{conf.reason}</span>
              </div>
            )}
            {inviteFor === lead.id ? (
              <div className="flex flex-col gap-2">
                <textarea
                  className="bg-gray-800 border border-gray-700 rounded-lg p-2 text-xs text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed"
                  rows={6} value={inviteText} onChange={(e) => setInviteText(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { if (!requireConn()) return; act(`invite:${lead.id}`, `/wf/invite/${lead.id}`, { message: inviteText }, `Invite sent to ${lead.name}`).then(() => setInviteFor(null)); }}
                    disabled={b('invite') || !inviteText.trim()}
                    className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded-lg">
                    {b('invite') ? 'Sending…' : invited ? 'Re-send invite' : 'Send invite'}
                  </button>
                  <button onClick={() => setInviteFor(null)} className="px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => openInvite(lead)} className="flex-1 bg-green-700 hover:bg-green-600 text-white text-xs font-medium py-1.5 rounded-lg">
                  {invited ? 'Edit / re-send' : 'Send invite'}
                </button>
                {invited && (
                  <>
                    <button onClick={() => act(`confirm:${lead.id}`, `/wf/confirm/${lead.id}`, null, `${lead.name} confirmed`)} disabled={b('confirm')}
                      className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs px-2.5 py-1.5 rounded-lg">Confirm</button>
                    <button onClick={() => act(`decline:${lead.id}`, `/wf/decline/${lead.id}`, null, `${lead.name} declined`)} disabled={b('decline')}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2.5 py-1.5 rounded-lg">Decline</button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* Confirmed column — assign a session */}
        {col === 'confirmed' && (
          <select
            defaultValue=""
            onChange={(e) => e.target.value && act(`slot:${lead.id}`, `/wf/slot/${lead.id}`, { session: e.target.value }, `${lead.name} slotted`)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-green-600">
            <option value="" disabled>Assign session…</option>
            {config?.sessions.map((s) => (
              <option key={s.id} value={s.id}>{sessionText(s)} ({sessionCounts[s.id] || 0}/{s.capacity})</option>
            ))}
          </select>
        )}

        {/* Slotted column — mark attendance */}
        {col === 'slotted' && (
          <>
            <span className="text-xs text-gray-300">Session: <span className="text-green-300">{sessionLabel(lead.wf?.session)}</span></span>
            <button onClick={() => act(`attend:${lead.id}`, `/wf/attend/${lead.id}`, null, `${lead.name} marked attended`)} disabled={b('attend')}
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded-lg">
              {b('attend') ? '…' : 'Mark attended'}
            </button>
          </>
        )}

        {/* Attended column — send agreement */}
        {col === 'attended' && (
          <>
            <span className="text-xs text-gray-500">Sends: {defaultDoc ? defaultDoc.name : 'no document uploaded'}</span>
            <button onClick={() => { if (!requireConn()) return; act(`agree:${lead.id}`, `/wf/agreement/${lead.id}`, {}, `Agreement sent to ${lead.name}`); }}
              disabled={b('agree') || !defaultDoc}
              className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded-lg">
              {b('agree') ? 'Sending…' : 'Send agreement'}
            </button>
          </>
        )}

        {/* Agreement column — bot auto-validates the returned signed PDF */}
        {col === 'agreement_sent' && (
          <div className="text-xs flex flex-col gap-1">
            {lead.wf?.agreement && (
              <span className="text-gray-500">Sent {fmtDateTime(lead.wf.agreement.sentAt)} · {lead.wf.agreement.fileNames?.join(', ')}</span>
            )}
            {!lead.wf?.signed && <span className="text-purple-300">Awaiting signed copy…</span>}
            {lead.wf?.signed && (() => {
              const r = lead.wf!.signed!.result;
              return (
                <div className={`rounded-lg px-2 py-1.5 border ${r?.complete ? 'border-green-700 bg-green-950/30 text-green-300' : 'border-amber-800 bg-amber-950/20 text-amber-300'}`}>
                  {r?.complete ? '✓ Signed & complete — moved to onboarding' : `⚠ Incomplete (attempt ${lead.wf!.signed!.attempts}) — auto-chased`}
                  {!r?.complete && r?.missing?.length ? <span className="block text-gray-400 mt-0.5">Missing: {r.missing.join(', ')}</span> : null}
                  {r && !r.signed ? <span className="block text-gray-500">No signature detected</span> : null}
                </div>
              );
            })()}
          </div>
        )}

        {/* Onboarding — bot auto-books on reply; manual assign as fallback */}
        {col === 'onboarding' && (
          <>
            <span className="text-xs text-teal-300">Offered — lead replies to pick (bot books automatically)</span>
            <select
              defaultValue=""
              onChange={(e) => e.target.value && act(`oslot:${lead.id}`, `/wf/onboard-slot/${lead.id}`, { session: e.target.value }, `${lead.name} booked`)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-green-600">
              <option value="" disabled>Assign manually…</option>
              {config?.onboardingSessions.map((s) => <option key={s.id} value={s.id}>{sessionText(s)}</option>)}
            </select>
          </>
        )}

        {/* Booked into onboarding — take attendance */}
        {col === 'onboarding_slotted' && (
          <>
            <span className="text-xs text-gray-300">Onboarding: <span className="text-emerald-300">{onbLabel(lead.wf?.onboardingSession)}</span></span>
            <button onClick={() => act(`onb:${lead.id}`, `/wf/onboard/${lead.id}`, null, `${lead.name} onboarded 🎉`)} disabled={b('onb')}
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded-lg">
              {b('onb') ? '…' : 'Mark onboarded (Sales Rep)'}
            </button>
          </>
        )}

        {/* On-board */}
        {col === 'onboarded' && (
          <span className="text-xs text-green-300">✅ Sales Rep{lead.wf?.onboardedAt ? ` · ${fmtDateTime(lead.wf.onboardedAt)}` : ''}</span>
        )}

        {/* Manual move */}
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value; if (!v) return;
            act(`move:${lead.id}`, `/wf/stage/${lead.id}`, { stage: v === 'inbox' ? null : v }, `Moved ${lead.name}`);
          }}
          className="text-[11px] text-gray-500 bg-transparent border-0 focus:outline-none cursor-pointer self-end">
          <option value="">Move ▾</option>
          {MOVE_TARGETS.filter((m) => m.value !== col).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <h2 className="text-base sm:text-lg font-semibold text-gray-100">Recruitment Pipeline</h2>
        <span className="text-xs sm:text-sm text-gray-500">{COLUMNS.reduce((n, c) => n + colLeads[c.key].length, 0)} in pipeline</span>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button onClick={() => setSettingsTab('brief')} className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">Brief message</button>
          <button onClick={() => setSettingsTab('sessions')} className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">Sessions</button>
          <button onClick={() => setSettingsTab('onboarding')} className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">Onboarding</button>
          <button onClick={() => setSettingsTab('documents')} className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200">Documents</button>
        </div>
      </div>

      {/* Stage tabs */}
      <div className="px-4 sm:px-6 border-b border-gray-800 flex gap-1 overflow-x-auto">
        {COLUMNS.map((c) => {
          const active = activeStage === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setActiveStage(c.key)}
              className={`px-3 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
                active ? 'border-green-500 text-green-400' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {c.title}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-green-900 text-green-200' : 'bg-gray-800 text-gray-500'}`}>
                {colLeads[c.key].length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Cards for the selected stage — one stage per page, responsive grid */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <p className="text-xs text-gray-500 mb-4">{activeCol?.hint}</p>
        {colLeads[activeStage].length === 0 ? (
          <div className="text-sm text-gray-700 text-center py-16 border border-dashed border-gray-800 rounded-xl">
            No leads in {activeCol?.title}.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
            {colLeads[activeStage].map((l) => renderCard(l, activeStage))}
          </div>
        )}
      </div>

      {settingsTab && (
        <Settings
          tab={settingsTab} setTab={setSettingsTab}
          config={config} docs={docs}
          showToast={showToast}
          onConfigSaved={loadConfig} onDocsChanged={loadDocs}
        />
      )}
    </div>
  );
}

// ── Settings modal (Brief template / Sessions / Documents) ─────────────────────────
function Settings({ tab, setTab, config, docs, showToast, onConfigSaved, onDocsChanged }: {
  tab: 'brief' | 'sessions' | 'onboarding' | 'documents';
  setTab: (t: null | 'brief' | 'sessions' | 'onboarding' | 'documents') => void;
  config: Config | null;
  docs: DocMeta[];
  showToast: (m: string, ok?: boolean) => void;
  onConfigSaved: () => void;
  onDocsChanged: () => void;
}) {
  const [briefDraft, setBriefDraft] = useState(config?.briefTemplate || '');
  const [sessionsDraft, setSessionsDraft] = useState<Session[]>(config?.sessions || []);
  const [obSessionsDraft, setObSessionsDraft] = useState<Session[]>(config?.onboardingSessions || []);
  const [requiredDraft, setRequiredDraft] = useState((config?.requiredFields || []).join('\n'));
  const [chaseDraft, setChaseDraft] = useState(config?.chaseTemplate || '');
  const [obTemplateDraft, setObTemplateDraft] = useState(config?.onboardingTemplate || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setBriefDraft(config?.briefTemplate || '');
    setSessionsDraft(config?.sessions || []);
    setObSessionsDraft(config?.onboardingSessions || []);
    setRequiredDraft((config?.requiredFields || []).join('\n'));
    setChaseDraft(config?.chaseTemplate || '');
    setObTemplateDraft(config?.onboardingTemplate || '');
  }, [config]);

  const saveConfig = async (body: object, msg: string) => {
    setSaving(true);
    const { ok, data } = await post('/config', body);
    setSaving(false);
    if (ok && data.ok) { showToast(msg); onConfigSaved(); } else showToast(data.error || 'Save failed', false);
  };

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      const { ok, data } = await post('/documents', { name: file.name, mimetype: file.type || 'application/pdf', dataBase64: base64 });
      if (ok && data.id) { showToast(`Uploaded ${file.name}`); onDocsChanged(); } else showToast(data.error || 'Upload failed', false);
    } catch { showToast('Upload failed', false); }
    finally { setUploading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setTab(null)}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex border-b border-gray-800 overflow-x-auto">
          {(['brief', 'sessions', 'onboarding', 'documents'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-3 text-sm whitespace-nowrap capitalize ${tab === t ? 'text-green-400 border-b-2 border-green-500' : 'text-gray-400 hover:text-gray-200'}`}>
              {t === 'brief' ? 'Brief message' : t}
            </button>
          ))}
          <button onClick={() => setTab(null)} className="ml-auto px-4 text-gray-500 hover:text-gray-200 shrink-0">✕</button>
        </div>

        <div className="p-5 overflow-auto">
          {tab === 'brief' && (
            <div className="flex flex-col gap-3">
              <label className="text-xs text-gray-400">Default invite message — <span className="text-gray-500">[Name] is replaced per lead</span></label>
              <textarea rows={10} value={briefDraft} onChange={(e) => setBriefDraft(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed" />
              <button onClick={() => saveConfig({ briefTemplate: briefDraft }, 'Brief message saved')} disabled={saving}
                className="self-end bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {tab === 'sessions' && (
            <div className="flex flex-col gap-3">
              <label className="text-xs text-gray-400">Briefing sessions leads can be slotted into — the date is included in the invite sent to leads</label>
              {sessionsDraft.map((s, i) => (
                <div key={i} className="flex gap-2 items-center flex-wrap sm:flex-nowrap">
                  <input value={s.label} onChange={(e) => setSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                    className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" placeholder="Label e.g. Thursday 7:30pm" />
                  <input type="date" value={s.date || ''} onChange={(e) => setSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, date: e.target.value } : x))}
                    className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                  <input type="number" value={s.capacity} title="Capacity" onChange={(e) => setSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, capacity: Number(e.target.value) } : x))}
                    className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                  <button onClick={() => setSessionsDraft((d) => d.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 px-2">✕</button>
                </div>
              ))}
              <button onClick={() => setSessionsDraft((d) => [...d, { id: `s${Date.now()}`, label: '', date: '', capacity: 10 }])}
                className="text-sm text-gray-400 hover:text-gray-200 self-start">+ Add session</button>
              <button onClick={() => saveConfig({ sessions: sessionsDraft.filter((s) => s.label.trim()) }, 'Sessions saved')} disabled={saving}
                className="self-end bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {tab === 'onboarding' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-400">Onboarding (2nd) sessions — offered automatically once the agreement is signed</label>
                {obSessionsDraft.map((s, i) => (
                  <div key={i} className="flex gap-2 items-center flex-wrap sm:flex-nowrap">
                    <input value={s.label} onChange={(e) => setObSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" placeholder="Label e.g. Onboarding — Mon 7pm" />
                    <input type="date" value={s.date || ''} onChange={(e) => setObSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, date: e.target.value } : x))}
                      className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                    <input type="number" value={s.capacity} title="Capacity" onChange={(e) => setObSessionsDraft((d) => d.map((x, j) => j === i ? { ...x, capacity: Number(e.target.value) } : x))}
                      className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-600" />
                    <button onClick={() => setObSessionsDraft((d) => d.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 px-2">✕</button>
                  </div>
                ))}
                <button onClick={() => setObSessionsDraft((d) => [...d, { id: `ob${Date.now()}`, label: '', date: '', capacity: 10 }])}
                  className="text-sm text-gray-400 hover:text-gray-200 self-start">+ Add onboarding session</button>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-400">Required fields on the signed agreement — one per line (drives auto-validation)</label>
                <textarea rows={6} value={requiredDraft} onChange={(e) => setRequiredDraft(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed" />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-400">Auto-chase when fields are missing — <span className="text-gray-500">[Name], [Missing]</span></label>
                <textarea rows={4} value={chaseDraft} onChange={(e) => setChaseDraft(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed" />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-400">Thank-you + onboarding offer (sent when complete) — <span className="text-gray-500">[Name], [Sessions]</span></label>
                <textarea rows={4} value={obTemplateDraft} onChange={(e) => setObTemplateDraft(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-green-600 leading-relaxed" />
              </div>

              <button
                onClick={() => saveConfig({
                  onboardingSessions: obSessionsDraft.filter((s) => s.label.trim()),
                  requiredFields: requiredDraft.split('\n').map((x) => x.trim()).filter(Boolean),
                  chaseTemplate: chaseDraft,
                  onboardingTemplate: obTemplateDraft,
                }, 'Onboarding settings saved')}
                disabled={saving}
                className="self-end bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {tab === 'documents' && (
            <div className="flex flex-col gap-3">
              <label className="text-xs text-gray-400">Agreement documents — the ⭐ default is sent at the Attended stage</label>
              {docs.map((d) => (
                <div key={d.id} className="flex items-center gap-2 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2">
                  <button title={d.isDefault ? 'Default' : 'Set as default'} onClick={async () => { await post(`/documents/${d.id}/default`); onDocsChanged(); }}
                    className={d.isDefault ? 'text-yellow-400' : 'text-gray-600 hover:text-yellow-300'}>★</button>
                  <span className="flex-1 text-sm text-gray-200 truncate">{d.name}</span>
                  <span className="text-xs text-gray-500">{Math.round(d.size / 1024)} KB</span>
                  <button onClick={async () => { await fetch(`${API}/documents/${d.id}`, { method: 'DELETE' }); onDocsChanged(); }}
                    className="text-gray-500 hover:text-red-400">✕</button>
                </div>
              ))}
              {docs.length === 0 && <p className="text-xs text-gray-600">No documents yet.</p>}
              <label className={`self-start text-sm px-4 py-2 rounded-lg cursor-pointer ${uploading ? 'opacity-50' : ''} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`}>
                {uploading ? 'Uploading…' : '+ Upload document'}
                <input type="file" accept="application/pdf,image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} disabled={uploading} />
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
