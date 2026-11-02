// en-CA formats a date as YYYY-MM-DD.
const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Business calendar day (Asia/Kolkata) of a timestamp, as YYYY-MM-DD. Unparseable input is returned unchanged. */
export function istDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : IST_DAY.format(time);
}
