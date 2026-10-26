import type { ServiceType } from '@/modules/fulfilment/contracts';

/*
 * Words for the services of the booking form (approved preview chips and
 * cards). Car is the existing transfer service (contract §2.4).
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

/** Chip and card titles, in the preview's order. */
export const SERVICE_CHIPS: ReadonlyArray<{ type: ServiceType; label: string; add: string; addEmpty: string }> = [
  { type: 'hotel', label: 'Hotels', add: 'Add stay', addEmpty: 'Add hotel stay' },
  { type: 'transfer', label: 'Cars', add: 'Add car', addEmpty: 'Add vehicle' },
  { type: 'flight', label: 'Flights', add: 'Add flight', addEmpty: 'Add flight' },
  { type: 'activity', label: 'Activities', add: 'Add details', addEmpty: 'Add requirements' },
  { type: 'visa', label: 'Visa', add: 'Add details', addEmpty: 'Add requirements' },
  { type: 'passport', label: 'Passport', add: 'Add details', addEmpty: 'Add requirements' },
];
