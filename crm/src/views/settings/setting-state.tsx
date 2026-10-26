import { CircleCheck, CircleHelp, CircleOff, type LucideIcon } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import type { SwitchState } from '@/modules/settings/contracts';

/*
 * DA-253 state words: On · Off · Unknown, each with its own icon (never
 * colour alone). Unknown has its own look and is never drawn as Off.
 */
const LOOK: Record<SwitchState, { word: string; tone: StatusTone; icon: LucideIcon }> = {
  on: { word: 'On', tone: 'success', icon: CircleCheck },
  off: { word: 'Off', tone: 'neutral', icon: CircleOff },
  unknown: { word: 'Unknown', tone: 'warning', icon: CircleHelp },
};

export function SettingStateBadge({ state, label = 'Current state', word }: { state: SwitchState; label?: string; word?: string }) {
  const look = LOOK[state];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap data-state={state}>
      <span className="sr-only">{label}: </span>
      {word ?? look.word}
    </StatusBadge>
  );
}
