# Suppliers, hotels sold and supplier import: design notes (Accounts phase 2, Track E, 11 Nov 2026)

Business rules come from the frozen Accounts phase 2 contract (sections 5, 11.9, 11.10, 13.3, 13.4; Addendum L2: supplier kind values `direct` and `channel`, label "Agent or booking channel"; Addendum L3: form field names). Every screen is composed from the existing CRM kit (`src/components/ui/*`), the Phase 1 Accounts desk dialog kit (`views/accounts-desk/desk-kit.tsx`: one form per dialog, request id renewed only after success, refusal keeps the values and marks the named field) and the Phase 4 supplier screens (bank details section reused unchanged). No new dependency.

## Screens and where they live

| Screen | Files | Preview states |
|---|---|---|
| Suppliers register (R-A1) | `register.tsx` | `acc2-supplier-register*` |
| Supplier page: details, contacts, hotels sold, history, duplicate warnings (R-A2) | `supplier-page.tsx`, `forms.tsx`; bank section `../procurement-views.tsx` `SupplierBankSection` | `acc2-supplier-page*` |
| Flight suppliers card: kind, GSTIN, PAN, state on "Add supplier"; link to the supplier page | `../flight/suppliers.tsx` | (Flight work tab states) |
| Quote form hotel picker (13.4) | `../purchase/work-forms.tsx` `AddRateForm` (`catalogue`, `searchHotels` props) | `acc2-supplier-rate-picker*` |
| Settings › Imports › Suppliers (5.6, 13.3) | `import-rows.tsx`, `../settings/import-view.tsx`, `../booking-form/vn-types.ts` (`SupplierImportSummary`) | `acc2-supplier-import*` |

Shapes: `types.ts` mirrors R-A1/R-A2/R-A3 and the 13.4 workspace keys (type-only, no runtime import in client code).

## Interaction decisions (accessibility, not policy)

- Register search and filters are a plain GET form (search box always visible; the other filters in a `<details>` that opens by itself when one is set). Active filters show as removable chip links plus "Clear all". "Show more suppliers" is a link to the next keyset page. From 640 px the table keeps its six columns and scrolls inside its own labelled, focusable region; under 640 px each row is a labelled card. PAN is always masked in the register.
- One primary action per screen: the register's "Add a supplier" (jumps to the form; the form's own button is secondary); the supplier page's "Verify details" for a Manager, or "Save details" for an editor on the Details tab.
- The supplier page header carries kind, verification and bank state (icon + words) and one "Next:" line. Possible duplicates are a warning notice with links to the other suppliers ("Looks like … (same GSTIN) — check before saving"); never a block. A save that returns warnings says "Saved, but it looks like a supplier you already have".
- Tabs are link tabs (`?tab=contacts|hotels|history`), so they work without script and keep the back button. "Hotels sold" shows only for suppliers that sell hotels.
- Contacts: primary contact marked with a star badge and the word "Primary"; add/edit/remove each open one dialog with one primary button; remove needs a reason (10–300). The primary checkbox cannot be cleared on the primary contact itself (aria-disabled plus one line saying why).
- Link a hotel: the existing ARIA 1.2 search combobox over the hotel list; only a picked hotel is sent (`hotelId`); an unpicked name is refused with the field marked.
- GSTIN/PAN/state are checked in the browser with the database's own rules (shape, PAN = GSTIN characters 3–12, state = first two digits); the database decides. A masked PAN is never sent back: the PAN field starts empty and says "On file: XXXXX9876X. Leave empty to keep it."
- Quote picker: the hotel defaults to the booking's catalogue hotel; suppliers who sell it come first in an `<optgroup>` "Sell this hotel"; the hotel name stays free text (typing clears the catalogue id; picking another hotel from the list sets it).
- Import: warnings never block and name the existing supplier as a link; rows match by the ID column only (said on screen); bank details show holder, bank, IFSC and "•••• last 4" (screen readers hear "account ending"); a notice says imported bank details start unverified and payments stay on hold until a Manager who did not apply the import approves them. The row list scrolls inside its own focusable region.
- Reduced motion: only kit animations (with `motion-reduce:` variants).

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only; no supplier, bank or customer data was sent.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `vendor directory` | Job Listing (educalvolpz) | No | A marketing card list; the register needs a dense, filterable table. Kept the CRM table with stacked phone rows. |
| 2 | `contact list` | Contacts Table With Modal, Contact Card, Item List with Actions, Contact Cards, Messaging people list | Idea only (Item List with Actions) | One row per person with trailing actions; no avatars, follower counts or bulk select. Primary shown as a badge with the word "Primary". |
| 3 | `audit log` | Audit Log (corr), Audit Log Table, Audit Log With Icon Tiles, Interactive Logs Table, Illos Audit Log Panel | Idea only (Audit Log) | When / who / what / before / after columns; no severity colours, avatars, IPs or CSV export (history is read-only and bank values never appear). |
| 4 | `duplicate warning` | Alert (serafimcloud), Note (shugar), Announcement, Toast, Warning Alert (cnippet) | Idea only (Warning Alert) | The kit Notice in warning tone with a title and a list of links; not a toast (it must stay on screen) and not dismissible. |
| 5 | `csv import` | Import Patchbay, ReUI trace CSV import, CSV / TSV Viewer | Idea only (ReUI trace: rejected records with their problems) | The existing check-then-apply flow stays; supplier rows add outcome badge, values, masked bank and per-row warnings. No drag-cable column mapper (columns map by header; the summary lists the mapping). |
| 6 | `combobox` | Combobox (prebuiltui, coss.com, anubra266, shugar, halaska-studio) | Already in the kit | The CRM `SearchCombobox` (built earlier from the same references) is reused for the hotel picker and "Link a hotel". |

## Not done here (reported to the lead)

- Route wiring waits for track A's `S/modules/suppliers/server/**` (not present when this was built): the register and supplier routes still render the Phase 4 views.
- `views/purchase/work-tab.tsx` must pass `catalogue` (from `purchase_workspace` 13.4 keys) and `searchHotels` to `AddRateForm`.
