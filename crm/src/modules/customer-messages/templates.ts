import type { Language, MessageType } from './contracts';

/**
 * The frozen customer message texts (contract 5.7, LD35, Addendum O1): nine
 * types x English and Hindi. Templates are the only source of message text.
 * `body` is the WhatsApp template body with numbered variables ({{1}} = the
 * first param of the type, contract 5.5); WhatsApp adds `footer`. The e-mail
 * uses `subject` and the same body text with the company block (no STOP line:
 * STOP applies to WhatsApp only). Codes match whatsapp_templates and
 * authz.cmsg_template_code: tn_<type>_<lang>_v1. Utility texts (Meta rules):
 * no offers and no links other than the document.
 *
 * Hindi bodies keep the same variables (same numbers, same count); the lead
 * shows both languages to the owner with the Interakt submission steps.
 */

export interface CustomerMessageTemplate {
  code: string;
  subject: string;
  body: string;
  footer: string;
  header: 'none' | 'document';
}

export const STOP_FOOTER: Readonly<Record<Language, string>> = Object.freeze({
  en: 'Reply STOP to stop these messages',
  hi: 'ये संदेश बंद करने के लिए STOP लिखें',
});

/** Params of each type in variable order (contract 5.5; mirror of authz.cmsg_param_keys). */
export const MESSAGE_PARAM_KEYS: Readonly<Record<MessageType, readonly string[]>> = Object.freeze({
  booking_confirmed: ['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd', 'travellerCount'],
  payment_received: ['customerName', 'dealReference', 'amountPaise', 'balancePaise'],
  hotel_voucher: ['customerName', 'dealReference', 'hotelName', 'checkIn', 'checkOut'],
  e_ticket: ['customerName', 'dealReference'],
  boarding_pass: ['customerName', 'dealReference'],
  visa_status: ['customerName', 'dealReference', 'travellerName', 'outcome'],
  trip_reminder: ['customerName', 'dealReference', 'destination', 'tripStart', 'daysLeft'],
  refund_paid: ['customerName', 'dealReference', 'amountPaise'],
  booking_changed: ['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd'],
});

const t = (type: MessageType, lang: Language, subject: string, body: string, header: 'none' | 'document' = 'none'): CustomerMessageTemplate =>
  Object.freeze({ code: `tn_${type}_${lang}_v1`, subject, body, footer: STOP_FOOTER[lang], header });

export const CUSTOMER_MESSAGE_TEMPLATES: Readonly<Record<MessageType, Readonly<Record<Language, CustomerMessageTemplate>>>> = Object.freeze({
  booking_confirmed: Object.freeze({
    en: t('booking_confirmed', 'en', 'Your booking {{2}} is confirmed',
      'Hello {{1}}, your booking {{2}} with Holiday Chacha is confirmed. Trip: {{3}}, {{4}} to {{5}}, {{6}} traveller(s). We will send your documents here.'),
    hi: t('booking_confirmed', 'hi', 'आपकी बुकिंग {{2}} पक्की हो गई है',
      'नमस्ते {{1}}, हॉलिडे चाचा के साथ आपकी बुकिंग {{2}} पक्की हो गई है। यात्रा: {{3}}, {{4}} से {{5}} तक, {{6}} यात्री। आपके दस्तावेज़ हम यहीं भेजेंगे।'),
  }),
  payment_received: Object.freeze({
    en: t('payment_received', 'en', 'Payment received for booking {{2}}',
      'Hello {{1}}, we have received your payment of Rs {{3}} for booking {{2}}. Balance: Rs {{4}}. Thank you.'),
    hi: t('payment_received', 'hi', 'बुकिंग {{2}} का भुगतान मिल गया',
      'नमस्ते {{1}}, बुकिंग {{2}} के लिए आपका Rs {{3}} का भुगतान हमें मिल गया है। बाकी राशि: Rs {{4}}। धन्यवाद।'),
  }),
  hotel_voucher: Object.freeze({
    en: t('hotel_voucher', 'en', 'Your hotel voucher for booking {{2}}',
      'Hello {{1}}, your hotel voucher for {{3}} ({{4}} to {{5}}), booking {{2}}, is attached.', 'document'),
    hi: t('hotel_voucher', 'hi', 'बुकिंग {{2}} का होटल वाउचर',
      'नमस्ते {{1}}, बुकिंग {{2}} के लिए {{3}} ({{4}} से {{5}} तक) का आपका होटल वाउचर साथ में है।', 'document'),
  }),
  e_ticket: Object.freeze({
    en: t('e_ticket', 'en', 'Your e-ticket for booking {{2}}',
      'Hello {{1}}, your e-ticket for booking {{2}} is attached. Please check the names and dates.', 'document'),
    hi: t('e_ticket', 'hi', 'बुकिंग {{2}} का ई-टिकट',
      'नमस्ते {{1}}, बुकिंग {{2}} का आपका ई-टिकट साथ में है। कृपया नाम और तारीखें जाँच लें।', 'document'),
  }),
  boarding_pass: Object.freeze({
    en: t('boarding_pass', 'en', 'Your boarding pass for booking {{2}}',
      'Hello {{1}}, your boarding pass for booking {{2}} is attached.', 'document'),
    hi: t('boarding_pass', 'hi', 'बुकिंग {{2}} का बोर्डिंग पास',
      'नमस्ते {{1}}, बुकिंग {{2}} का आपका बोर्डिंग पास साथ में है।', 'document'),
  }),
  visa_status: Object.freeze({
    en: t('visa_status', 'en', 'Visa update for booking {{2}}',
      'Hello {{1}}, visa update for {{3}} on booking {{2}}: {{4}}. Your Holiday Chacha contact will call you with the next steps.'),
    hi: t('visa_status', 'hi', 'बुकिंग {{2}} के वीज़ा की जानकारी',
      'नमस्ते {{1}}, बुकिंग {{2}} पर {{3}} के वीज़ा की जानकारी: {{4}}। आगे क्या करना है, यह बताने के लिए हॉलिडे चाचा से आपका संपर्क व्यक्ति आपको फ़ोन करेगा।'),
  }),
  trip_reminder: Object.freeze({
    en: t('trip_reminder', 'en', 'Your trip starts soon (booking {{2}})',
      'Hello {{1}}, your trip to {{3}} (booking {{2}}) starts on {{4}} — {{5}} day(s) to go. Please keep your ID and tickets ready.'),
    hi: t('trip_reminder', 'hi', 'आपकी यात्रा जल्द शुरू हो रही है (बुकिंग {{2}})',
      'नमस्ते {{1}}, {{3}} की आपकी यात्रा (बुकिंग {{2}}) {{4}} को शुरू हो रही है — {{5}} दिन बाकी हैं। कृपया अपना पहचान पत्र और टिकट तैयार रखें।'),
  }),
  refund_paid: Object.freeze({
    en: t('refund_paid', 'en', 'Refund paid for booking {{2}}',
      'Hello {{1}}, we have paid your refund of Rs {{3}} for booking {{2}}. It may take a few working days to show in your account.'),
    hi: t('refund_paid', 'hi', 'बुकिंग {{2}} का रिफ़ंड भेज दिया गया',
      'नमस्ते {{1}}, बुकिंग {{2}} के लिए Rs {{3}} का आपका रिफ़ंड हमने भेज दिया है। आपके खाते में दिखने में कुछ कामकाजी दिन लग सकते हैं।'),
  }),
  booking_changed: Object.freeze({
    en: t('booking_changed', 'en', 'Your booking {{2}} has been updated',
      'Hello {{1}}, your booking {{2}} has been updated. Trip: {{3}}, {{4}} to {{5}}. Your Holiday Chacha contact will share the details.'),
    hi: t('booking_changed', 'hi', 'आपकी बुकिंग {{2}} में बदलाव हुआ है',
      'नमस्ते {{1}}, आपकी बुकिंग {{2}} में बदलाव किया गया है। यात्रा: {{3}}, {{4}} से {{5}} तक। हॉलिडे चाचा से आपका संपर्क व्यक्ति पूरी जानकारी देगा।'),
  }),
});

/** Whole paise -> "25,000" or "25,000.50" (Indian grouping). Never a float. */
export function formatRupees(paise: string): string {
  if (!/^\d{1,18}$/.test(paise)) return paise;
  const p = BigInt(paise);
  const rupees = (p / 100n).toString();
  const rest = p % 100n;
  const last3 = rupees.slice(-3);
  const head = rupees.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return rest === 0n ? grouped : `${grouped}.${rest.toString().padStart(2, '0')}`;
}

const OUTCOME_TEXT: Readonly<Record<Language, Readonly<Record<string, string>>>> = Object.freeze({
  en: Object.freeze({ approved: 'approved', not_approved: 'not approved' }),
  hi: Object.freeze({ approved: 'स्वीकृत', not_approved: 'स्वीकृत नहीं' }),
});

/** Variable values in order, as the customer reads them. Missing values become "-". */
export function templateValues(type: MessageType, language: Language, params: Readonly<Record<string, unknown>>): string[] {
  return MESSAGE_PARAM_KEYS[type].map((key) => {
    const raw = params[key];
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (value === '') return '-';
    if (key === 'amountPaise' || key === 'balancePaise') return formatRupees(value);
    if (key === 'outcome') return OUTCOME_TEXT[language][value] ?? '-';
    // WhatsApp variables may not hold line breaks or tabs.
    return value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  });
}

function fill(text: string, values: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? '-');
}

const COMPANY_BLOCK: Readonly<Record<Language, string>> = Object.freeze({
  en: 'Holiday Chacha Pvt Ltd\nThis is an automatic message about your booking.',
  hi: 'Holiday Chacha Pvt Ltd\nयह आपकी बुकिंग के बारे में अपने-आप भेजा गया संदेश है।',
});

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** The e-mail of a message: subject, plain text and plain branded HTML. */
export function renderEmail(type: MessageType, language: Language, params: Readonly<Record<string, unknown>>): RenderedEmail {
  const tpl = CUSTOMER_MESSAGE_TEMPLATES[type][language];
  const values = templateValues(type, language, params);
  const subject = fill(tpl.subject, values);
  const body = fill(tpl.body, values);
  const text = `${body}\n\n${COMPANY_BLOCK[language]}`;
  const html = `<!doctype html><html lang="${language}"><body style="font-family:Arial,sans-serif;color:#1f2933;line-height:1.5">`
    + `<p style="font-size:18px;font-weight:bold;color:#0f766e">Holiday Chacha</p>`
    + `<p>${escapeHtml(body)}</p>`
    + `<p style="font-size:12px;color:#52606d">${escapeHtml(COMPANY_BLOCK[language]).replace(/\n/g, '<br>')}</p>`
    + '</body></html>';
  return { subject, text, html };
}

/** Synthetic preview values for the Settings page (R-A2). */
export const PREVIEW_PARAMS: Readonly<Record<string, string>> = Object.freeze({
  customerName: 'Asha Example',
  dealReference: 'SYN-DEL-001',
  destination: 'Udaipur',
  tripStart: '01 Dec 2026',
  tripEnd: '04 Dec 2026',
  travellerCount: '2',
  amountPaise: '2500000',
  balancePaise: '1000000',
  hotelName: 'Lakeview Example Hotel',
  checkIn: '01 Dec 2026',
  checkOut: '04 Dec 2026',
  travellerName: 'Asha Example',
  outcome: 'approved',
  daysLeft: '3',
});

/** The WhatsApp text of a template with synthetic values (body + footer). */
export function previewWhatsApp(type: MessageType, language: Language): string {
  const tpl = CUSTOMER_MESSAGE_TEMPLATES[type][language];
  return `${fill(tpl.body, templateValues(type, language, PREVIEW_PARAMS))}\n${tpl.footer}`;
}
