import type { ReactNode } from 'react';
import {
  PAYMENT_MODE_WORDS,
  dealLine,
  formatRupees,
  type CustomerDocumentContent,
} from '@/modules/customer-documents/content';
import { isPlaceholder } from '../text';

/**
 * Customer document template (Accounts phase 2, contract 6.8): Advance
 * Invoice, Invoice and Credit Note from the frozen cdoc-1 content. Same CSS
 * family as the branded quotation and itinerary templates (./document.css
 * under .tn-doc; class names only, never style attributes). A value the
 * content does not know prints as <span class="fill">Label</span>, the marker
 * the page check counts; any placeholder blocks the PDF.
 *
 * No "not a tax invoice" line (owner answer Q1). The linked Tally GST
 * invoice number prints when the content carries it (LD18). The Deal line
 * prints the Bitrix Deal id when known, else the CRM Deal reference.
 *
 * Pure markup: no hooks, no data access, no client code, so it renders in a
 * Server Component (print page, staff print view, draft preview), in a client
 * component and with react-dom/server (local render worker).
 */

function V({ v }: { v: string | number | null | undefined }): ReactNode {
  if (isPlaceholder(v)) return <span className="fill">{v.trim().slice(1, -1)}</span>;
  return v === null || v === undefined ? null : String(v);
}

function Fill({ label }: { label: string }) {
  return <span className="fill">{label}</span>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-20" -> "20 Nov 2026". */
export function longDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

function Customer({ c }: { c: CustomerDocumentContent['customer'] }) {
  if (!c) {
    return (
      <p>
        <Fill label="Billing details" />
      </p>
    );
  }
  return (
    <>
      <p className="doc-strong">{c.billingName}</p>
      <p>{c.addressLine1}</p>
      {c.addressLine2 ? <p>{c.addressLine2}</p> : null}
      <p>
        {c.city} {c.postalCode} · State code {c.stateCode}
      </p>
      {c.gstin ? <p>GSTIN {c.gstin}</p> : null}
    </>
  );
}

function Trip({ t }: { t: CustomerDocumentContent['trip'] }) {
  const dates = [longDate(t.startDate), longDate(t.endDate)].filter(Boolean).join(' to ');
  const parts = [t.destination, dates || null, t.travellerCount ? `${t.travellerCount} ${t.travellerCount === 1 ? 'traveller' : 'travellers'}` : null]
    .filter(Boolean);
  return parts.length ? <p>{parts.join(' · ')}</p> : null;
}

export function CustomerDocumentTemplate({ content, id }: { content: CustomerDocumentContent; id?: string }) {
  const c = content;
  const deal = dealLine(c);
  const isInvoice = c.kind === 'invoice';
  return (
    <article className="tn-doc" id={id} aria-label={`${c.title}${c.number ? ` ${c.number}` : ''}`}>
      <header className="doc-head">
        <div>
          <p className="doc-brand">{c.company.legalName}</p>
          <p className="doc-tagline">{c.branch.name ? `${c.branch.name} branch` : null}</p>
        </div>
        <div className="doc-meta">
          <p>
            <strong>{c.title}</strong> {c.number ?? 'Draft (number on release)'}
          </p>
          <p>Date {longDate(c.issueDate) ?? 'on release'}</p>
          <p>
            {deal.label} {deal.value}
          </p>
          {c.gstInvoiceNumber ? <p>GST invoice no. {c.gstInvoiceNumber}</p> : null}
        </div>
      </header>
      <div className="doc-bar" aria-hidden="true" />

      <section className="doc-cols">
        <div className="doc-section">
          <h3>Billed to</h3>
          <Customer c={c.customer} />
        </div>
        <div className="doc-section">
          <h3>Trip</h3>
          <Trip t={c.trip} />
        </div>
      </section>

      {c.replaces ? <p className="doc-note">This document replaces {c.replaces.number}.</p> : null}
      {c.credits ? (
        <p className="doc-note">
          Credit against {c.credits.title} {c.credits.number}.
        </p>
      ) : null}

      <section className="doc-section">
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((line, i) => (
              <tr key={i}>
                <td>{line.label}</td>
                <td className="num">{formatRupees(line.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="num doc-strong">{formatRupees(c.totalPaise)}</td>
            </tr>
            {isInvoice ? (
              <>
                <tr>
                  <th scope="row">Paid so far</th>
                  <td className="num">{formatRupees(c.paidPaise)}</td>
                </tr>
                <tr>
                  <th scope="row">Balance due</th>
                  <td className="num doc-strong">{formatRupees(c.balancePaise ?? '0')}</td>
                </tr>
              </>
            ) : null}
          </tfoot>
        </table>
      </section>

      {c.payment ? (
        <section className="doc-section">
          <h3>Payment received</h3>
          <p>
            {formatRupees(c.paidPaise)} on {longDate(c.payment.receivedOn)} by {PAYMENT_MODE_WORDS[c.payment.mode]} · Payment reference{' '}
            {c.payment.reference}
          </p>
        </section>
      ) : null}

      {c.plan && c.plan.length ? (
        <section className="doc-section">
          <h3>Payment plan</h3>
          <table className="doc-table">
            <tbody>
              {c.plan.map((p, i) => (
                <tr key={i}>
                  <td>{p.label}</td>
                  <td>{longDate(p.dueDate)}</td>
                  <td className="num">{formatRupees(p.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <footer className="doc-foot">
        <p className="doc-legal">
          {c.company.legalName} · Regd. office: {c.company.registeredAddress} · PAN {c.company.pan} · GSTIN <V v={c.company.gstin} />
          {c.company.gstinState ? ` (${c.company.gstinState})` : ''}
        </p>
      </footer>
    </article>
  );
}
