import type { ContactStatus } from '../types';

interface Props {
  status: ContactStatus;
}

const CONFIG: Record<ContactStatus, { label: string; classes: string }> = {
  verified: {
    label: 'Verified professional email',
    classes: 'bg-green-50 text-green-700 border-green-200',
  },
  catchall: {
    label: 'Catch-all domain',
    classes: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  risky: {
    label: 'Unverified / risky',
    classes: 'bg-orange-50 text-orange-700 border-orange-200',
  },
  invalid: {
    label: 'Do not use',
    classes: 'bg-red-50 text-red-700 border-red-200',
  },
  not_found: {
    label: 'No email found',
    classes: 'bg-cream text-muted border-frame',
  },
};

export default function EmailStatusBadge({ status }: Props) {
  const { label, classes } = CONFIG[status];
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-widest font-medium px-2 py-0.5 border ${classes}`}
    >
      {label}
    </span>
  );
}
