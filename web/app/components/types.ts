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

// Ordered recruitment-pipeline stages (Phase 1).
export type Stage = 'brief' | 'confirmed' | 'slotted' | 'attended' | 'agreement_sent' | 'declined';

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
};

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
};

export type WaStatus = { state: 'open' | 'connecting' | 'close'; qr: string | null; ai?: boolean; autoReply?: boolean };

export type Session = { id: string; label: string; date?: string; capacity: number };

export type DocMeta = { id: string; name: string; mimetype: string; size: number; uploadedAt: string; isDefault: boolean };

export type Config = { autoReply: boolean; sessions: Session[]; briefTemplate: string };

// Display metadata for each pipeline stage — shared by the board and the leads table.
export const STAGE_META: Record<string, { label: string; chip: string }> = {
  brief: { label: 'Brief', chip: 'bg-amber-900/60 border-amber-700 text-amber-300' },
  confirmed: { label: 'Confirmed', chip: 'bg-blue-900/60 border-blue-700 text-blue-300' },
  slotted: { label: 'Slotted', chip: 'bg-cyan-900/60 border-cyan-700 text-cyan-300' },
  attended: { label: 'Attended', chip: 'bg-green-900/60 border-green-700 text-green-300' },
  agreement_sent: { label: 'Agreement Sent', chip: 'bg-purple-900/60 border-purple-700 text-purple-300' },
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
  { value: 'declined', label: 'Declined' },
];

// Short "sub-flow" caption describing exactly where in a stage a lead sits.
export function subFlow(l: Lead): string {
  const s = l.stage;
  if (s === 'brief') return l.wf?.confirmation ? `AI: ${l.wf.confirmation.status}` : l.wf?.invitedAt ? 'invited' : 'to invite';
  if (s === 'confirmed') return 'to slot';
  if (s === 'slotted') return 'scheduled';
  if (s === 'attended') return 'send agreement';
  if (s === 'agreement_sent') return 'awaiting signed';
  if (s === 'declined') return '';
  if (!s && l.ai?.category === 'interested') return 'interested';
  return l.sent ? 'sent' : 'new';
}
