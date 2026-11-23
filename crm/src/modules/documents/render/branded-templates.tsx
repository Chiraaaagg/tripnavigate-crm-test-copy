import type { ReactNode } from 'react';
import { GST_TEXT, type DocumentIdentity, type PackageDocumentInput, type QuoteDocumentInput } from '../contracts';
import { isPlaceholder } from '../text';

/**
 * Branded customer document templates (B1.2 Phase F; Luna). Same props as
 * the plain templates, so the render worker and the in-app HTML preview use
 * one component. Styles live in ./document.css under .tn-doc (class names
 * only, never style attributes: the app's style policy and the PDF use the
 * same markup). A missing fact renders as <span class="fill">Label</span>,
 * the marker the page check counts; any placeholder blocks a final document.
 *
 * Pure markup: no hooks, no data access, no client code, so it renders in a
 * Server Component, in a client component and with react-dom/server.
 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (rupees: number) => `₹${inr.format(rupees)}`;

function V({ v }: { v: string | number | null | undefined }): ReactNode {
  if (isPlaceholder(v)) return <span className="fill">{v.trim().slice(1, -1)}</span>;
  return v === null || v === undefined ? null : String(v);
}

function Brand() {
  return (
    <div>
      <p className="doc-brand">
        Trip<b>Navigate</b>
      </p>
      <p className="doc-tagline">We make travel effortless.</p>
    </div>
  );
}

/**
 * DEC-50 statutory line (approved company identity): legal name, registered
 * office, PAN and the branch GSTIN with its state. A GSTIN not given yet
 * prints as a placeholder, which blocks a final document.
 */
function IdentityLine({ identity }: { identity: DocumentIdentity }) {
  return (
    <p className="doc-legal">
      {identity.legalName} · Regd. office: {identity.registeredAddress} · PAN {identity.pan} · GSTIN <V v={identity.gstin} />
      {identity.gstinState ? ` (${identity.gstinState})` : ''}
    </p>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function BrandedQuotationTemplate({ input, id }: { input: QuoteDocumentInput; id?: string }) {
  const q = input;
  const travellers = [
    q.pax.adults ? plural(q.pax.adults, 'adult', 'adults') : null,
    q.pax.childWithBed ? plural(q.pax.childWithBed, 'child with a bed', 'children with a bed') : null,
    q.pax.childNoBed ? plural(q.pax.childNoBed, 'child without a bed', 'children without a bed') : null,
    q.pax.infants ? plural(q.pax.infants, 'infant', 'infants') : null,
  ]
    .filter(Boolean)
    .join(', ');
  const twoTiers = q.tiers.length > 1;
  return (
    <article className="tn-doc" id={id} aria-label={`Customer quotation ${q.quoteNo}${q.revision > 1 ? `, revision ${q.revision}` : ''}`}>
      <header className="doc-head">
        <Brand />
        <div className="doc-meta">
          <p>
            <strong>Tour quotation</strong> {q.quoteNo}
            {q.revision > 1 ? ` · Rev ${q.revision}` : ''}
          </p>
          <p>Date {q.date}</p>
          <p>
            Valid until <V v={q.validUntil} />
          </p>
        </div>
      </header>
      <div className="doc-bar" aria-hidden="true" />
      <h2 className="doc-title">
        <V v={q.trip.title} />
      </h2>
      <p className="doc-sub">
        For <V v={q.customer.name} /> · <V v={q.trip.start} /> to <V v={q.trip.end} /> · {plural(q.trip.nights, 'night', 'nights')}, {plural(q.trip.days, 'day', 'days')}
        {q.trip.cities.length ? ` · ${q.trip.cities.join(', ')}` : ''}
      </p>
      <p className="doc-sub">
        {travellers || 'Travellers to be confirmed'}
        {q.pax.basis ? (
          <>
            {' · '}
            <V v={q.pax.basis} />
          </>
        ) : null}
      </p>
      {q.revision > 1 && q.revisionNote ? <p className="doc-note doc-section">What changed: {q.revisionNote}</p> : null}

      <section className="doc-section" aria-label="Your price">
        <h3>Your price</h3>
        <div className={twoTiers ? 'doc-prices two' : 'doc-prices'}>
          {q.tiers.map((t) => (
            <div key={t.name} className={t.quoted ? 'doc-price main' : 'doc-price'}>
              <p className="doc-price-name">
                {t.name}
                {t.label ? (
                  <>
                    {' · '}
                    <V v={t.label} />
                  </>
                ) : null}
              </p>
              <p className="doc-amount">{money(t.total)}</p>
              <p className="doc-small">{t.perPerson !== null ? `${money(t.perPerson)} per person` : `total for ${plural(q.price.paxCount, 'traveller', 'travellers')}`}</p>
              {t.hotels.length ? (
                <ul className="doc-small">
                  {t.hotels.map((h, i) => (
                    <li key={i}>
                      <V v={h} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
        <p className="doc-small doc-section">
          {q.price.totalWords}. {q.price.gstText}. {q.price.notTaxInvoice}.
        </p>
        {q.price.categories.length ? (
          <table className="doc-table doc-section">
            <caption className="doc-label">What the price covers</caption>
            <tbody>
              {q.price.categories.map((c) => (
                <tr key={c.k}>
                  <th scope="row">{c.k}</th>
                  <td>{c.note}</td>
                  {c.amt !== null ? <td className="num">{money(c.amt)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {q.stay.length ? (
        <section className="doc-section" aria-label="Where you stay">
          <h3>Where you stay</h3>
          <ul className="doc-list">
            {q.stay.map((s, i) => (
              <li key={i}>
                <span className="doc-strong">{s.city}</span> · <V v={s.hotel} /> · <V v={s.room} />
                <span className="doc-small">
                  {' '}
                  (<V v={s.plan} />)
                </span>
                <p className="doc-small">
                  <V v={s.in} /> to <V v={s.out} /> · {plural(s.nights, 'night', 'nights')} · <V v={s.rooms} /> {s.rooms === 1 ? 'room' : 'rooms'}
                  {s.note ? (
                    <>
                      {' · '}
                      <V v={s.note} />
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {q.flights.length ? (
        <section className="doc-section" aria-label="Flights">
          <h3>Flights</h3>
          <ul className="doc-list">
            {q.flights.map((f, i) => (
              <li key={i}>
                <span className="doc-strong">
                  {f.label} · {f.date}
                </span>
                {f.legs.map((l, j) => (
                  <p key={j}>
                    {l.from} to {l.to} · <V v={l.carrier} /> <V v={l.no} /> · <V v={l.dep} /> – <V v={l.arr} />
                  </p>
                ))}
                <p className="doc-small">
                  Baggage: <V v={f.baggage} />
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {q.days.length ? (
        <section className="doc-section" aria-label="Day by day">
          <h3>Day by day</h3>
          {q.days.map((d) => (
            <div key={d.n} className="doc-day">
              <p className="doc-day-n">Day {d.n}</p>
              <div>
                <p className="doc-strong">
                  <V v={d.t} />
                  {d.city ? (
                    <span className="doc-small">
                      {' · '}
                      <V v={d.city} />
                    </span>
                  ) : null}
                </p>
                <p>
                  <V v={d.d} />
                </p>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="doc-section doc-cols" aria-label="Included and not included">
        <div>
          <h4 className="doc-label">Included</h4>
          <ul>{q.includes.length ? q.includes.map((x) => <li key={x}>{x}</li>) : <li>As listed above</li>}</ul>
        </div>
        <div>
          <h4 className="doc-label">Not included</h4>
          <ul>{q.excludes.length ? q.excludes.map((x) => <li key={x}>{x}</li>) : <li>Anything not listed as included</li>}</ul>
        </div>
      </section>

      {q.payment.length ? (
        <section className="doc-section" aria-label="Payment schedule">
          <h3>Payment schedule if you confirm</h3>
          <table className="doc-table">
            <tbody>
              {q.payment.map((p) => (
                <tr key={p.k}>
                  <th scope="row">{p.k}</th>
                  <td>
                    <V v={p.when} />
                  </td>
                  <td className="num">{money(p.amt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {q.terms && q.terms.length ? (
        <section className="doc-section" aria-label="Good to know">
          <h3>Good to know</h3>
          <ul>
            {q.terms.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="doc-section doc-note" aria-label="Next step">
        <p>
          To confirm, reply in writing (WhatsApp or e-mail) to {q.preparedBy.name}
          {q.preparedBy.phone ? (
            <>
              {' '}
              (<V v={q.preparedBy.phone} />)
            </>
          ) : null}
          , saying which option you choose. Availability is checked when you confirm.
        </p>
      </section>

      <footer className="doc-foot">
        <IdentityLine identity={q.identity} />
        <span>
          Prepared by {q.preparedBy.name}, {q.preparedBy.role}
        </span>
        <span>{q.price.notTaxInvoice}</span>
      </footer>
    </article>
  );
}

export function BrandedItineraryTemplate({ input, id }: { input: PackageDocumentInput; id?: string }) {
  const p = input;
  return (
    <article className="tn-doc" id={id} aria-label={`Customer itinerary ${p.code}`}>
      <header className="doc-head">
        <Brand />
        <div className="doc-meta">
          <p>
            <strong>Itinerary</strong> {p.code}
          </p>
          <p>Prepared {p.generated}</p>
        </div>
      </header>
      <div className="doc-bar" aria-hidden="true" />
      <h2 className="doc-title">{p.destination}</h2>
      <p className="doc-sub">
        {plural(p.nights, 'night', 'nights')}, {plural(p.days, 'day', 'days')}
        {p.country ? (
          <>
            {' · '}
            <V v={p.country} />
          </>
        ) : null}
        {p.category ? (
          <>
            {' · '}
            <V v={p.category} />
          </>
        ) : null}
      </p>
      <p className="doc-sub">
        Pickup <V v={p.pickup} /> · Drop <V v={p.drop} />
        {p.paxBasis ? (
          <>
            {' · '}
            <V v={p.paxBasis} />
          </>
        ) : null}
      </p>
      {p.bases.length ? (
        <ul className="doc-chips doc-section" aria-label="Where you base yourself">
          {p.bases.map((b) => (
            <li key={b.name}>
              {b.name} · {plural(b.nights, 'night', 'nights')}
            </li>
          ))}
        </ul>
      ) : null}
      {p.intro.length ? (
        <section className="doc-section" aria-label="Introduction">
          {p.intro.map((x, i) => (
            <p key={i}>
              <V v={x} />
            </p>
          ))}
        </section>
      ) : null}

      {p.hotels.length ? (
        <section className="doc-section" aria-label="Where you stay">
          <h3>Where you stay</h3>
          <ul className="doc-list">
            {p.hotels.map((h, i) => (
              <li key={i}>
                <span className="doc-strong">{h.city}</span> · {plural(h.nights, 'night', 'nights')} · <V v={h.hotel} /> · <V v={h.room} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="doc-section" aria-label="Day by day">
        <h3>Day by day</h3>
        {p.daysList.map((d) => (
          <div key={d.n} className="doc-day">
            <p className="doc-day-n">Day {d.n}</p>
            <div>
              <p className="doc-strong">
                <V v={d.title} />
                <span className="doc-small">
                  {' · '}
                  <V v={d.base} />
                </span>
              </p>
              <p>
                <V v={d.story} />
              </p>
              {d.highlights.length ? (
                <ul className="doc-chips">
                  {d.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
              <p className="doc-small">
                {d.meal ? (
                  <>
                    Meals: <V v={d.meal} />
                    {' · '}
                  </>
                ) : null}
                Stay: <V v={d.stay} />
              </p>
            </div>
          </div>
        ))}
      </section>

      {p.moves.length ? (
        <section className="doc-section" aria-label="Every move">
          <h3>Every move</h3>
          <ul>
            {p.moves.map((m, i) => (
              <li key={i}>
                <V v={m.day} />: {m.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.weHandle.length || p.youBring.length ? (
        <section className="doc-section doc-cols" aria-label="We handle and you bring">
          <div>
            <h4 className="doc-label">We handle</h4>
            <ul>
              {p.weHandle.map((x, i) => (
                <li key={i}>
                  <V v={x} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="doc-label">You bring</h4>
            <ul>
              {p.youBring.map((x, i) => (
                <li key={i}>
                  <V v={x} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {p.reasons.length ? (
        <section className="doc-section" aria-label="Why this plan works">
          <h3>Why this plan works</h3>
          <ul className="doc-list">
            {p.reasons.map((r, i) => (
              <li key={i}>
                <span className="doc-strong">
                  <V v={r.title} />
                </span>
                <p>
                  <V v={r.body} />
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="doc-section doc-cols" aria-label="Included and not included">
        <div>
          <h4 className="doc-label">Included</h4>
          <ul>{p.inclusions.length ? p.inclusions.map((x) => <li key={x}>{x}</li>) : <li>As listed above</li>}</ul>
        </div>
        <div>
          <h4 className="doc-label">Not included</h4>
          <ul>{p.exclusions.length ? p.exclusions.map((x) => <li key={x}>{x}</li>) : <li>Anything not listed as included</li>}</ul>
        </div>
      </section>

      {p.tiers ? (
        <section className="doc-section" aria-label="Your price">
          <h3>Your price</h3>
          <div className={p.tiers.length > 1 ? 'doc-prices two' : 'doc-prices'}>
            {p.tiers.map((t, i) => (
              <div key={t.name} className={i === 0 ? 'doc-price main' : 'doc-price'}>
                <p className="doc-price-name">{t.name}</p>
                <p className="doc-amount">{money(t.total)}</p>
                <p className="doc-small">{t.perPerson !== null ? `${money(t.perPerson)} per person` : 'total for your group'}</p>
              </div>
            ))}
          </div>
          {/* DEC-48: selling prices only, as accepted on the quotation; never cost or margin; no GST amount. */}
          <p className="doc-small doc-section">{GST_TEXT}. Prices as on your accepted quotation; this itinerary is not a tax invoice.</p>
        </section>
      ) : null}

      <footer className="doc-foot">
        <IdentityLine identity={p.identity} />
        <span>Itinerary {p.code}</span>
      </footer>
    </article>
  );
}
