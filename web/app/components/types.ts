// Shared types for the dashboard + recruitment pipeline.

export type Reply = { text: string; timestamp: string };

export type SentReply = { text: string; timestamp: string; auto?: boolean; kind?: string };

export type AiResult = {
  category: 'interested' | 'not_interested' | 'question' | 'other';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggested_reply: string;
  classifiedAt: string;
  autoReplied?: boolean;
};

export type Confirmation = {
  status: 'confirmed' | 'declined' | 'unclear';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  detectedAt: string;
};

// Ordered recruitment-pipeline stages.
export type Stage =
  | 'brief' | 'confirmed' | 'slotted' | 'attended' | 'agreement_sent'
  | 'onboarding' | 'onboarding_slotted' | 'onboarded' | 'declined';

export type SignedResult = { signed: boolean; missing: string[]; complete: boolean; notes: string };

export type Wf = {
  enteredAt?: string;
  invitedAt?: string;
  inviteText?: string;
  confirmation?: Confirmation;
  confirmedAt?: string;
  declinedAt?: string;
  session?: string | null;
  slottedAt?: string;
  attendedAt?: string;
  agreement?: { sentAt: string; fileIds: string[]; fileNames: string[] };
  // Phase 2
  signed?: { attempts: number; receivedAt?: string; lastFile?: string; result?: SignedResult; history?: Array<Record<string, unknown>> };
  onboardingOfferedAt?: string;
  onboardingSession?: string | null;
  onboardingSlottedAt?: string;
  onboardedAt?: string;
};

export type Role = 'lead' | 'potential_onboard' | 'onboard';

export type Lead = {
  id: number;
  name: string;
  email: string;
  phone: string;
  created: string;
  notes: string;
  adviser?: string;
  sent: boolean;
  sentAt: string | null;
  replies: Reply[];
  sentReplies?: SentReply[];
  ai?: AiResult;
  stage?: Stage;
  wf?: Wf;
  role?: Role;
  status?: import('./status').Status; // canonical lifecycle state
  needsReply?: boolean;               // new inbound awaiting a human
  lastContactedAt?: string;           // last time WE messaged them (manual or bot)
};

// "3d ago" style relative time.
export function relTime(ts?: string | null): string {
  if (!ts) return '';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 0) return 'just now';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

const maxTs = (arr: (string | undefined)[]) => {
  const t = arr.filter(Boolean).map((x) => new Date(x as string).getTime()).filter((n) => !isNaN(n));
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
};
// Last time we contacted them (outbound: initial outreach, logged sends, manual mark-sent).
export const lastContactOf = (l: Lead): string | null =>
  maxTs([l.lastContactedAt, l.sentAt || undefined, ...(l.sentReplies || []).map((r) => r.timestamp)]);
// Last time they replied (inbound).
export const lastReplyOf = (l: Lead): string | null => maxTs((l.replies || []).map((r) => r.timestamp));

export type WaStatus = { state: 'open' | 'connecting' | 'close'; qr: string | null; ai?: boolean; autoReply?: boolean };

// A session is defined by a calendar date + time; the weekday + 12h label are derived.
// `label` is kept optional for backward-compat with older free-text sessions.
export type Session = { id: string; date?: string; time?: string; capacity: number; label?: string };

export function sessionTime12h(time?: string): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (isNaN(h)) return time;
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m || 0).padStart(2, '0')}${ap}`;
}

export function sessionWeekday(date?: string, long = false): string {
  if (!date) return '';
  const dt = new Date(date + 'T00:00:00');
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-SG', { weekday: long ? 'long' : 'short' });
}

// Human display: "Thu 7:30pm · 26 Jun" derived from date+time (falls back to legacy label).
export function sessionDisplay(s: { date?: string; time?: string; label?: string }): string {
  const main = [sessionWeekday(s.date), sessionTime12h(s.time)].filter(Boolean).join(' ');
  if (!main) return s.label || '(unset)';
  const dm = s.date ? new Date(s.date + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) : '';
  return dm ? `${main} · ${dm}` : main;
}

export type DocMeta = { id: string; name: string; mimetype: string; size: number; uploadedAt: string; isDefault: boolean };

export type Config = {
  autoReply: boolean;
  sessions: Session[];
  briefTemplate: string;
  onboardingSessions: Session[];
  requiredFields: string[];
  chaseTemplate: string;
  onboardingTemplate: string;
};

// Display metadata for each pipeline stage — shared by the board and the leads table.
export const STAGE_META: Record<string, { label: string; chip: string }> = {
  brief: { label: 'Brief', chip: 'bg-amber-900/60 border-amber-700 text-amber-300' },
  confirmed: { label: 'Confirmed', chip: 'bg-blue-900/60 border-blue-700 text-blue-300' },
  slotted: { label: 'Slotted', chip: 'bg-cyan-900/60 border-cyan-700 text-cyan-300' },
  attended: { label: 'Attended', chip: 'bg-green-900/60 border-green-700 text-green-300' },
  agreement_sent: { label: 'Agreement Sent', chip: 'bg-purple-900/60 border-purple-700 text-purple-300' },
  onboarding: { label: 'Onboarding', chip: 'bg-teal-900/60 border-teal-700 text-teal-300' },
  onboarding_slotted: { label: 'Onboarding Slotted', chip: 'bg-emerald-900/60 border-emerald-700 text-emerald-300' },
  onboarded: { label: 'On-board ✅', chip: 'bg-green-800/70 border-green-600 text-green-200' },
  declined: { label: 'Declined', chip: 'bg-red-950/60 border-red-800 text-red-300' },
};

// The ordered options shown in the leads-table status dropdown.
export const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'brief', label: 'Brief' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'slotted', label: 'Slotted' },
  { value: 'attended', label: 'Attended' },
  { value: 'agreement_sent', label: 'Agreement Sent' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'onboarding_slotted', label: 'Onboarding Slotted' },
  { value: 'onboarded', label: 'On-board (Sales Rep)' },
  { value: 'declined', label: 'Declined' },
];

// Short "sub-flow" caption describing exactly where in a stage a lead sits.
export function subFlow(l: Lead): string {
  const s = l.stage;
  if (s === 'brief') return l.wf?.confirmation ? `AI: ${l.wf.confirmation.status}` : l.wf?.invitedAt ? 'invited' : 'to invite';
  if (s === 'confirmed') return 'to slot';
  if (s === 'slotted') return 'scheduled';
  if (s === 'attended') return 'send agreement';
  if (s === 'agreement_sent') return l.wf?.signed ? (l.wf.signed.result?.complete ? 'signed ✓' : `missing ${l.wf.signed.result?.missing?.length ?? 0}`) : 'awaiting signed';
  if (s === 'onboarding') return 'pick onboarding';
  if (s === 'onboarding_slotted') return 'onboarding booked';
  if (s === 'onboarded') return 'Sales Rep';
  if (s === 'declined') return '';
  if (!s && l.ai?.category === 'interested') return 'interested';
  return l.sent ? 'sent' : 'new';
}
