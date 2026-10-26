import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isUiPreviewEnabled } from '@/lib/config';

export const dynamic = 'force-dynamic';

const PREVIEW_LINKS = [
  {
    group: 'Design System (Direction A)',
    links: [{ label: 'Component Gallery - Every Shared Component and State', href: '/preview/ui-gallery' }],
  },
  {
    group: 'Main Staff Views',
    links: [
      { label: 'Home - Sales Staff Dashboard', href: '/preview/home-sales' },
      { label: 'Staff Frame - Content Loading', href: '/preview/app-frame-loading' },
      { label: 'Home - Accounts Staff Dashboard', href: '/preview/home-accounts' },
      { label: 'Home - Manager (Leads and Purchase tasks)', href: '/preview/home-manager' },
      { label: 'Home - Nothing needs you (Sales, all counts zero)', href: '/preview/home-nothing' },
      { label: 'Home - Super Admin (no counts apply; Settings menu)', href: '/preview/home-super-admin' },
      { label: 'Home - Sales and Purchase (multi-role menu and counts)', href: '/preview/home-multi-role' },
      { label: 'Home - Counts unavailable', href: '/preview/home-my-work-unavailable' },
      { label: 'Staff Frame - Page error', href: '/preview/app-frame-error' },
      { label: 'Deals List (Sales)', href: '/preview/deals-sales' },
      { label: 'Deals List (Manager - Delhi branch grant)', href: '/preview/deals-manager-branch-grant' },
      { label: 'Deals List (Empty)', href: '/preview/deals-empty' },
      { label: 'Deals List (Lagoon: every row kind, more pages, live)', href: '/preview/deals-mixed' },
      { label: 'Deals List (empty page past the end, pager shown)', href: '/preview/deals-list-past-end' },
      { label: 'Deals List - Loading', href: '/preview/deals-loading' },
      { label: 'Deal Detail (Sales - with commercial margin)', href: '/preview/deal-detail-sales' },
      { label: 'Deal Detail (Purchase - margin hidden)', href: '/preview/deal-detail-purchase' },
      { label: 'Deal Page - Bitrix deal with booking, owner and Lead link', href: '/preview/deal-page-bitrix-booking' },
      { label: 'Deal Page - Purchase, sync overdue', href: '/preview/deal-page-purchase-stale' },
      { label: 'Deal Page - Waiting for owner', href: '/preview/deal-page-waiting' },
      { label: 'Deal Page - Long unbroken title and names', href: '/preview/deal-page-long-title' },
      { label: 'Deal Page - Loading', href: '/preview/deal-loading' },
      { label: 'Deal Not Found / Unauthorized', href: '/preview/deal-not-found' },
      { label: 'My Access Grants (Manager)', href: '/preview/my-access-manager' },
    ],
  },
  {
    group: 'Direction A Batch 1 (lists and Deal workspace)',
    links: [
      { label: 'Leads list - Sales (chips, search this page, details on demand)', href: '/preview/p6-leads-sales' },
      { label: 'Leads list - Mine filter, nothing matches', href: '/preview/p6-leads-mine-empty' },
      { label: 'Leads list - Counts unavailable', href: '/preview/p6-leads-counts-unavailable' },
      { label: 'Lead record - Overview / Quotations / Bitrix details', href: '/preview/p6-lead-sales' },
      { label: 'Lead record - Integration admin (no Quotations tab)', href: '/preview/p6-lead-admin-no-quotations' },
      { label: 'Deals list - Owned by you, nothing matches', href: '/preview/deals-filter-owned-empty' },
      { label: 'Deals list - Counts unavailable', href: '/preview/deals-counts-unavailable' },
      { label: 'Deals list - Accounts empty', href: '/preview/deals-accounts-empty' },
      { label: 'Deals list - Super Admin empty', href: '/preview/deals-super-admin-empty' },
      { label: 'Deal workspace - Sales owner (every tab)', href: '/preview/ws-deal-sales' },
      { label: 'Deal workspace - Sales, Money tab', href: '/preview/ws-deal-sales-money' },
      { label: 'Deal workspace - Sales, History tab', href: '/preview/ws-deal-sales-history' },
      { label: 'Deal workspace - Purchase (no Money, no Lead link)', href: '/preview/ws-deal-purchase' },
      { label: 'Deal workspace - Sales without price access', href: '/preview/ws-deal-noprice' },
      { label: 'Deal workspace - Branch Manager', href: '/preview/ws-deal-manager' },
      { label: 'Deal workspace - Not started (Start booking)', href: '/preview/ws-deal-state-not-started' },
      { label: 'Deal workspace - Quotation accepted', href: '/preview/ws-deal-state-quotation-accepted' },
      { label: 'Deal workspace - Ready to submit', href: '/preview/ws-deal-state-ready' },
      { label: 'Deal workspace - Waiting for Accounts', href: '/preview/ws-deal-state-waiting' },
      { label: 'Deal workspace - Returned by Accounts', href: '/preview/ws-deal-state-returned' },
      { label: 'Deal workspace - Being arranged', href: '/preview/ws-deal-state-arranged' },
      { label: 'Deal workspace - All services confirmed', href: '/preview/ws-deal-state-confirmed' },
      { label: 'Deal workspace - Lost in Bitrix', href: '/preview/ws-deal-state-lost' },
      { label: 'Deal workspace - Older hotel booking', href: '/preview/ws-deal-state-hotel-legacy' },
      { label: 'Deal workspace - Booking could not load', href: '/preview/ws-deal-state-could-not-load' },
      { label: 'Deal workspace - Waiting for owner, Bitrix late', href: '/preview/ws-deal-state-waiting-owner-stale' },
      { label: 'Deal workspace - History could not load', href: '/preview/ws-deal-error-history' },
      { label: 'Deal workspace - Documents could not load', href: '/preview/ws-deal-error-documents' },
    ],
  },
  {
    group: 'Direction A Batch 2 (Book now and quotation editing)',
    links: [
      { label: 'Book now step 1 - From Bitrix inline (switch on): markers, Bitrix now says, section check', href: '/preview/b2-book-inline-travellers' },
      { label: 'Book now step 2 - From Bitrix inline: date notice, details only change, hotel cards', href: '/preview/b2-book-inline-stay' },
      { label: 'Book now step 1 - Older draft: Fill empty fields from Bitrix', href: '/preview/b2-book-inline-fill-empty' },
      { label: 'Book now step 1 - Bitrix details not available', href: '/preview/b2-book-inline-unavailable' },
      { label: 'Book now step 1 - Switch off: today\'s From Bitrix panel (restyled)', href: '/preview/b12-book-prefill-travellers' },
      { label: 'Book now step 3 - Section list, first section to finish open', href: '/preview/b2-book-finish-to-finish' },
      { label: 'Book now step 2 - Three hotel cards', href: '/preview/b2-book-stay-three-hotels' },
      { label: 'Book now step 3 - Editor without price access (one line)', href: '/preview/b2-book-finish-no-price' },
      { label: 'Quotation - untouched draft (Not started, nothing red)', href: '/preview/b2-quote-untouched' },
      { label: 'Quotation - draft: Check and mark ready, parts, Save prices', href: '/preview/b2-quote-draft-saving' },
      { label: 'Quotation - Save prices refused part way (honest report)', href: '/preview/b2-quote-prices-refused' },
      { label: 'Quotation - From Bitrix inline (switch on)', href: '/preview/b2-quote-inline' },
      { label: 'Quotation - draft, server says not ready', href: '/preview/b12-quote-draft' },
    ],
  },
  {
    group: 'Admin Views',
    links: [
      { label: 'Staff Management (Super Admin)', href: '/preview/admin-staff' },
      { label: 'Staff Recovery & Verification Methods', href: '/preview/admin-staff-recovery' },
      { label: 'Staff Recovery (No Verification Method)', href: '/preview/admin-staff-recovery-no-method' },
      { label: 'Access Grants Management', href: '/preview/admin-grants' },
    ],
  },
  {
    group: 'Auth & Onboarding',
    links: [
      { label: 'Sign In Page (Live Route)', href: '/sign-in' },
      { label: 'Sign In Error State', href: '/preview/sign-in-error' },
      { label: 'Onboarding - Set Password', href: '/preview/onboarding-password' },
      { label: 'MFA Setup - Start', href: '/preview/mfa-enroll-start' },
      { label: 'MFA Setup - QR Code Display', href: '/preview/mfa-enroll-qr' },
      { label: 'MFA Challenge Prompt', href: '/preview/mfa-challenge' },
      { label: 'MFA Challenge Error', href: '/preview/mfa-challenge-error' },
      { label: 'Finish Onboarding', href: '/preview/finish-onboarding' },
      { label: 'Forgot Password Request', href: '/preview/forgot-password' },
      { label: 'Forgot Password Sent State', href: '/preview/forgot-password-sent' },
    ],
  },
  {
    group: 'Accounts - Company Accounts (Stage 2)',
    links: [
      { label: 'Company Accounts - Every State (Second Accounts Person)', href: '/preview/finance-destinations' },
      { label: 'Company Accounts - Maker View (Approve Unavailable)', href: '/preview/finance-destinations-own' },
      { label: 'Company Accounts - Empty', href: '/preview/finance-destinations-empty' },
      { label: 'Company Accounts - Add Form Refused', href: '/preview/finance-destinations-add-error' },
      { label: 'Company Accounts - Finance Switched Off', href: '/preview/finance-destinations-unavailable' },
      { label: 'Deal - Receipts Mapped and Unmapped', href: '/preview/finance-deal-destinations' },
      { label: 'Deal - Receipt Form, No Approved Account', href: '/preview/finance-deal-no-destination' },
      { label: 'Deal - Receipt Form, Company Accounts Not Loaded', href: '/preview/finance-deal-destinations-unavailable' },
      { label: 'Deal - Receipt Refused, Account Changed', href: '/preview/finance-deal-destination-changed' },
    ],
  },
  {
    group: 'Account Recovery & Session States',
    links: [
      { label: 'Account Recovery - Provider Pending', href: '/preview/account-recovery-provider-pending' },
      { label: 'Account Recovery - Provider Failed', href: '/preview/account-recovery-provider-failed' },
      { label: 'Account Recovery - Awaiting Re-enrollment', href: '/preview/account-recovery-awaiting-reenrollment' },
      { label: 'Account Recovery - Registration Error', href: '/preview/account-recovery-register-error' },
      { label: 'Account Recovery - Confirmation Code', href: '/preview/account-recovery-awaiting-confirmation' },
      { label: 'Account Recovery - Other Device Code', href: '/preview/account-recovery-code-other-device' },
      { label: 'Account Recovery - Multiple Devices Error', href: '/preview/account-recovery-register-multiple' },
      { label: 'Account Recovery - Completed', href: '/preview/account-recovery-completed' },
      { label: 'Session Expired', href: '/session-expired' },
      { label: 'Signed Out', href: '/signed-out' },
      { label: 'Account panel with sign-out options open', href: '/preview/shell-sign-out-everywhere' },
    ],
  },
];

export default function PreviewIndexPage() {
  if (!isUiPreviewEnabled(process.env)) notFound();

  return (
    <main style={{ maxWidth: '840px', margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div className="preview-banner" role="note" style={{ marginBottom: '24px' }}>
        Design preview gallery: synthetic props, no authentication, no provider and no database.
      </div>
      <h1 style={{ fontSize: '26px', fontWeight: 'bold', marginBottom: '8px' }}>TripNavigate CRM — UI Preview Hub</h1>
      <p style={{ color: '#4b5563', marginBottom: '32px' }}>
        All views are loaded with synthetic props. Click any view below to inspect the design:
      </p>

      {PREVIEW_LINKS.map((section) => (
        <section key={section.group} style={{ marginBottom: '32px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '14px', borderBottom: '1px solid #e5e7eb', paddingBottom: '6px', color: '#111827' }}>
            {section.group}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px' }}>
            {section.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  borderRadius: '6px',
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  color: '#1d4ed8',
                  textDecoration: 'none',
                  fontSize: '14px',
                  fontWeight: '500',
                }}
              >
                <span>{link.label}</span>
                <span aria-hidden="true">&rarr;</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
