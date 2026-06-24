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

export type Session = { id: string; label: string; capacity: number };

export type DocMeta = { id: string; name: string; mimetype: string; size: number; uploadedAt: string; isDefault: boolean };

export type Config = { autoReply: boolean; sessions: Session[]; briefTemplate: string };
