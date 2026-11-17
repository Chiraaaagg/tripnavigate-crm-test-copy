import type { ReactNode } from 'react';
import type { DocumentIdentity, PackageDocumentInput, QuoteDocumentInput } from '../contracts';
import { isPlaceholder } from '../text';

/**
 * Minimal plain templates for the renderer seam: correct content, no design.
 * Superseded by ./branded-templates.tsx (render-view uses the branded ones);
 * kept as the content reference with the same props. Placeholders render as <span class="fill">Label</span>, the
 * marker the page check counts.
 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (rupees: number) => `₹${inr.format(rupees)}`;

function V({ v }: { v: string | number | null | undefined }): ReactNode {
  if (isPlaceholder(v)) return <span className="fill">{v.trim().slice(1, -1)}</span>;
  return v === null || v === undefined ? null : String(v);
}

/** DEC-50 statutory line; a GSTIN not given yet is a placeholder. */
function IdentityLine({ identity }: { identity: DocumentIdentity }) {
  return (
    <p>
      {identity.legalName} · Regd. office: {identity.registeredAddress} · PAN {identity.pan} · GSTIN <V v={identity.gstin} />
      {identity.gstinState ? ` (${identity.gstinState})` : ''}
    </p>
  );
}

export function PlainQuotationTemplate({ input }: { input: QuoteDocumentInput }) {
  const q = input;
  return (
    <main>
      <header>
        <h1>Tour quotation {q.quoteNo}{q.revision > 1 ? ` · Rev ${q.revision}` : ''}</h1>
        {q.revision > 1 && q.revisionNote ? <p>{q.revisionNote}</p> : null}
        <p>Date {q.date} · Valid until <V v={q.validUntil} /></p>
        <p>
          Prepared by {q.preparedBy.name}, {q.preparedBy.role} · <V v={q.preparedBy.phone} />
        </p>
        <p>
          For <V v={q.customer.name} /> · <V v={q.customer.phone} />
        </p>
      </header>
      <section>
        <h2><V v={q.trip.title} /></h2>
        <p>
          {q.trip.nights} nights, {q.trip.days} days · {q.trip.cities.join(', ')} · <V v={q.trip.start} /> to <V v={q.trip.end} />
        </p>
        <p>
          {q.pax.adults} adults, {q.pax.childWithBed} children with bed, {q.pax.childNoBed} children without bed, {q.pax.infants} infants · <V v={q.pax.basis} />
        </p>
        <ul>{q.covers.map((c) => <li key={c.k}>{c.in ? 'Included' : 'Not included'}: {c.k}</li>)}</ul>
      </section>
      <section>
        <h2>Price</h2>
        <p>
          {money(q.price.total)} {q.price.perPerson !== null ? `(${money(q.price.perPerson)} per person)` : `total for ${q.price.paxCount} travellers`}
        </p>
        <p>{q.price.totalWords}</p>
        <p>{q.price.gstText}</p>
        <table>
          <tbody>
            {q.price.categories.map((c) => (
              <tr key={c.k}><th>{c.k}</th><td>{c.note}</td><td>{c.amt !== null ? money(c.amt) : ''}</td></tr>
            ))}
          </tbody>
        </table>
        {q.tiers.map((t) => (
          <div key={t.name}>
            <h3>{t.name}: <V v={t.label} /></h3>
            <p>{money(t.total)}{t.perPerson !== null ? ` · ${money(t.perPerson)} per person` : ''}</p>
            <ul>{t.hotels.map((h, i) => <li key={i}><V v={h} /></li>)}</ul>
          </div>
        ))}
      </section>
      <section>
        <h2>The plan</h2>
        <ol>{q.days.map((d) => <li key={d.n}><V v={d.city} />: <V v={d.t} /> — <V v={d.d} /></li>)}</ol>
        <h2>Where you will stay</h2>
        <ul>
          {q.stay.map((s, i) => (
            <li key={i}>
              {s.city}, <V v={s.in} /> to <V v={s.out} />, {s.nights} nights: <V v={s.hotel} />, <V v={s.room} />, <V v={s.plan} />, <V v={s.rooms} /> rooms (<V v={s.note} />)
            </li>
          ))}
        </ul>
        {q.flights.length ? <h2>Flights</h2> : null}
        {q.flights.map((f, i) => (
          <div key={i}>
            <h3>{f.label} · {f.date}</h3>
            <ul>{f.legs.map((l, j) => <li key={j}><V v={l.carrier} /> <V v={l.no} /> {l.from} to {l.to}, <V v={l.dep} /> – <V v={l.arr} /></li>)}</ul>
            <p>Baggage: <V v={f.baggage} /></p>
          </div>
        ))}
      </section>
      <section>
        <h2>Included</h2>
        <ul>{q.includes.map((x) => <li key={x}>{x}</li>)}</ul>
        <h2>Not included</h2>
        <ul>{q.excludes.map((x) => <li key={x}>{x}</li>)}</ul>
        {q.payment.length ? <h2>Payment</h2> : null}
        <ul>{q.payment.map((p) => <li key={p.k}>{p.k}: {money(p.amt)} — <V v={p.when} /></li>)}</ul>
        {q.terms?.length ? <><h2>Terms</h2><ul>{q.terms.map((t) => <li key={t}>{t}</li>)}</ul></> : null}
      </section>
      <footer>
        <IdentityLine identity={q.identity} />
        <p>{q.price.notTaxInvoice}</p>
      </footer>
    </main>
  );
}

export function PlainItineraryTemplate({ input }: { input: PackageDocumentInput }) {
  const p = input;
  return (
    <main>
      <header>
        <h1>{p.destination}</h1>
        <p><V v={p.destinationShort} /> · <V v={p.country} /> · <V v={p.category} /></p>
        <p>{p.nights} nights, {p.days} days · Pickup <V v={p.pickup} /> · Drop <V v={p.drop} /> · <V v={p.paxBasis} /></p>
        <p>Itinerary {p.code} · prepared {p.generated}</p>
      </header>
      <section>{p.intro.map((x, i) => <p key={i}><V v={x} /></p>)}</section>
      <section>
        <h2>Where you will stay</h2>
        <ul>{p.hotels.map((h, i) => <li key={i}>{h.city}, {h.nights} nights: <V v={h.hotel} />, <V v={h.room} /></li>)}</ul>
      </section>
      <section>
        <h2>Day by day</h2>
        {p.daysList.map((d) => (
          <article key={d.n}>
            <h3>Day {d.n} · <V v={d.base} />: <V v={d.title} /></h3>
            <p><V v={d.story} /></p>
            {d.highlights.length ? <ul>{d.highlights.map((h) => <li key={h}>{h}</li>)}</ul> : null}
            <p>{d.meal ? <>Meals: <V v={d.meal} /> · </> : null}Stay: <V v={d.stay} /></p>
          </article>
        ))}
      </section>
      <section>
        <h2>Every move</h2>
        <ul>{p.moves.map((m, i) => <li key={i}><V v={m.day} />: {m.title}</li>)}</ul>
        <h2>We handle</h2>
        <ul>{p.weHandle.map((x, i) => <li key={i}><V v={x} /></li>)}</ul>
        <h2>You bring</h2>
        <ul>{p.youBring.map((x, i) => <li key={i}><V v={x} /></li>)}</ul>
        <h2>Why this plan works</h2>
        <ul>{p.reasons.map((r, i) => <li key={i}><V v={r.title} />: <V v={r.body} /></li>)}</ul>
      </section>
      <section>
        <h2>Included</h2>
        <ul>{p.inclusions.map((x) => <li key={x}>{x}</li>)}</ul>
        <h2>Not included</h2>
        <ul>{p.exclusions.map((x) => <li key={x}>{x}</li>)}</ul>
        {p.tiers ? (
          <>
            <h2>Your price</h2>
            <ul>{p.tiers.map((t) => <li key={t.name}>{t.name}: {money(t.total)}{t.perPerson !== null ? ` (${money(t.perPerson)} per person)` : ''}</li>)}</ul>
          </>
        ) : null}
      </section>
      <footer>
        <IdentityLine identity={p.identity} />
      </footer>
    </main>
  );
}
