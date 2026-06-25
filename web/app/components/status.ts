// ── Canonical lead lifecycle (single source of truth) ───────────────────────────
// Every lead is in exactly ONE status. Each view is a filter over this — never a
// second home for the lead.

export type Status =
  // outreach
  | 'new' | 'contacted'
  // inbox / triage (needs a human decision)
  | 'question' | 'review'
  // recruitment pipeline (ordered)
  | 'interested' | 'invited' | 'confirmed' | 'scheduled' | 'attended'
  | 'agreement' | 'signed' | 'onboarding' | 'booked' | 'onboarded'
  // closed
  | 'declined' | 'opted_out';

export type StatusGroup = 'outreach' | 'inbox' | 'pipeline' | 'closed';

export const STATUS_META: Record<Status, { label: string; group: StatusGroup; chip: string }> = {
  new:        { label: 'New',                 group: 'outreach', chip: 'bg-gray-800 border-gray-700 text-gray-400' },
  contacted:  { label: 'Contacted',           group: 'outreach', chip: 'bg-sky-950 border-sky-800 text-sky-300' },
  question:   { label: 'Question',            group: 'inbox',    chip: 'bg-yellow-900/60 border-yellow-700 text-yellow-300' },
  review:     { label: 'Needs review',        group: 'inbox',    chip: 'bg-orange-900/50 border-orange-700 text-orange-300' },
  interested: { label: 'Interested',          group: 'pipeline', chip: 'bg-amber-900/60 border-amber-700 text-amber-300' },
  invited:    { label: 'Invited',             group: 'pipeline', chip: 'bg-amber-900/50 border-amber-700 text-amber-200' },
  confirmed:  { label: 'Confirmed',           group: 'pipeline', chip: 'bg-blue-900/60 border-blue-700 text-blue-300' },
  scheduled:  { label: 'Scheduled',           group: 'pipeline', chip: 'bg-cyan-900/60 border-cyan-700 text-cyan-300' },
  attended:   { label: 'Attended',            group: 'pipeline', chip: 'bg-green-900/60 border-green-700 text-green-300' },
  agreement:  { label: 'Agreement sent',      group: 'pipeline', chip: 'bg-purple-900/60 border-purple-700 text-purple-300' },
  signed:     { label: 'Signed',              group: 'pipeline', chip: 'bg-fuchsia-900/60 border-fuchsia-700 text-fuchsia-300' },
  onboarding: { label: 'Onboarding',          group: 'pipeline', chip: 'bg-teal-900/60 border-teal-700 text-teal-300' },
  booked:     { label: 'Booked',              group: 'pipeline', chip: 'bg-emerald-900/60 border-emerald-700 text-emerald-300' },
  onboarded:  { label: 'On-board (Sales Rep)',group: 'pipeline', chip: 'bg-green-800/70 border-green-600 text-green-200' },
  declined:   { label: 'Declined',            group: 'closed',   chip: 'bg-red-950/60 border-red-800 text-red-300' },
  opted_out:  { label: 'Opted out',           group: 'closed',   chip: 'bg-gray-900 border-gray-700 text-gray-500' },
};

// Ordered pipeline statuses — drives the Pipeline tabs and the Analytics funnel.
export const PIPELINE_ORDER: Status[] = [
  'interested', 'invited', 'confirmed', 'scheduled', 'attended',
  'agreement', 'signed', 'onboarding', 'booked', 'onboarded',
];

export const INBOX_STATUSES: Status[] = ['question', 'review'];

export const ALL_STATUSES: Status[] = [
  'new', 'contacted', ...INBOX_STATUSES, ...PIPELINE_ORDER, 'declined', 'opted_out',
];

export const groupOf = (s?: Status): StatusGroup | undefined => (s ? STATUS_META[s]?.group : undefined);
export const rankOf = (s?: Status): number => (s ? PIPELINE_ORDER.indexOf(s) : -1);
