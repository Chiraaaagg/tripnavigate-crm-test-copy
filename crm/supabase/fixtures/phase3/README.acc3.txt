Accounts phase 3 synthetic fixtures (contract accounts-phase3-2026-11-12 section 19, 13 November 2026).
Made-up data only: every name, phone, e-mail, ledger, bank value and reference is invented
(@example.test, SYN- Deals, phones 60000xxxxx, SYN/TEST bank codes). Never put real data here.
This folder is OPT-IN: the seed loader and the database test harness read only the top-level
fixture files, so the policy-parity suites keep their exact fixture Deals.

acc3_scenarios.sql: four scenario Deals built through the real commands (see its header).
  Load with loadAcc3Scenarios(db) (tests/helpers/db.ts) or, on a disposable stack, once:
    psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/fixtures/phase3/acc3_scenarios.sql
  d...0301 SYN-ACC3-HINDI, d...0302 SYN-ACC3-NOMAIL, d...0303 SYN-ACC3-HOTELS, d...0304 SYN-ACC3-BAL3
  (ids d0000000-0000-4000-8000-000000000301..304). Dates are relative to the day it is loaded.
  It also creates the supplier "SYN Acc3 Stays" (hotel, approved bank details), the catalogue
  hotels SYN-ACC3-H-001 "SYN Acc3 Lake Hotel" and SYN-ACC3-H-002 "SYN Acc3 Fort Hotel" (both
  sold by that supplier) and the approved company bank destination "SYN Acc3 fixture bank".

acc3-syn-rate-sheet.csv (UTF-8, CRLF): contract 9.4 columns as the header (the database keys;
  the optional city column narrows hotelRef). Rupees. One contract per hotel, validity
  2026-12-01..2027-11-30, seasons 2026-12-01..2027-03-31 and 2027-04-01..2027-11-30.
  SYN-ACC3-H-001: Deluxe Room and Premium Room x CP and MAP, weekend rates, extras, two blackouts.
  SYN-ACC3-H-002: Deluxe Room, meal plan given as its label "Breakfast" (= CP), no weekend rate.
  Dry run after acc3_scenarios.sql (checked on PGlite, 13 Nov): 10 rows create, 0 invalid,
  2 contracts, 10 lines, 3 new room types (room types are per hotel). Needs the scenario
  supplier and hotels (supplierRef by exact name, hotelRef by source_ref) and the rate
  contracts switch On.

acc3-syn-rate-sheet-invalid.csv: same header. Dry run (checked on PGlite, 13 Nov), by row:
  1 supplier_not_found, 2 hotel_not_found, 3 dates_invalid, 4 season_outside_validity,
  5 meal_plan_invalid, 6 rate_invalid, 7 create, 8 line_overlap (overlaps row 7), 9 create,
  10 duplicate_in_file (same as row 9; the first row wins), 11 formula_cell + rate_invalid.
  Summary: 2 create, 9 invalid, 1 contract, 2 lines.
  supplier_does_not_sell_hotel is not in the file (needs a hotel the supplier does not sell).

acc3-syn-tally-daybook.xml (UTF-8 with declaration, CRLF): a TallyPrime Day Book exported as XML
  (ENVELOPE > BODY > IMPORTDATA > REQUESTDATA > TALLYMESSAGE > VOUCHER, Tally's own export shape;
  no DTD, no entities). Six vouchers, narrations in the frozen 7.3 format:
    Receipt 1  TN:TE-2026-000001/1  20000.00  matches the SYN-ACC3-HOTELS receipt when it is line 1
    Receipt 2  TN:TE-2026-000001/2  10000.00  matches the SYN-ACC3-BAL3 receipt when it is line 2
    Payment 1  TN:TE-2026-000001/3   9100.00  amount_differs against the 9000.00 supplier payment
    Receipt 3  TN:TE-2026-000099/1    500.00  not_found
    Receipt 4  TN:TE-2026-000001/1  20000.00  duplicate_in_file (same tag as Receipt 1)
    Receipt 5  (no tag)               250.00  no_tag
  The TN: tags point at the first XML file (TE-2026-000001) of a fresh stack; a test that makes
  another file first rewrites the tags (export number and line numbers) before uploading.
