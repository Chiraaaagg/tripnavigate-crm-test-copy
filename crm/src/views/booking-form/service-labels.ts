import type { ServiceType } from '@/modules/fulfilment/contracts';

/*
 * Words for the services of the booking form (Book now v2 prototype LABEL).
 * Car is the existing transfer service. Change 13: the header button is the
 * only add action of a card; the empty line is text only.
 */

/** Singular name of one service of a type. */
export const SERVICE_KIND_LABEL: Record<ServiceType, string> = {
  hotel: 'Hotel',
  transfer: 'Car',
  flight: 'Flight',
  activity: 'Activity',
  visa: 'Visa',
  passport: 'Passport',
};

/** Chip and card titles, in the prototype's order. */
export const SERVICE_CHIPS: ReadonlyArray<{ type: ServiceType; label: string; add: string }> = [
  { type: 'hotel', label: 'Hotels', add: 'Add hotel' },
  { type: 'transfer', label: 'Cars', add: 'Add car' },
  { type: 'flight', label: 'Flights', add: 'Add flight' },
  { type: 'activity', label: 'Activities', add: 'Add activity' },
  { type: 'visa', label: 'Visa', add: 'Add visa details' },
  { type: 'passport', label: 'Passport', add: 'Add passport details' },
];
