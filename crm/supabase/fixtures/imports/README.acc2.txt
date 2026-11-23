Synthetic supplier import samples (Accounts phase 2, 11 November 2026).
Made-up data only: every name, phone, e-mail, address, ID, GSTIN, PAN and
bank value here is invented for tests (example.test addresses, TST- IDs,
TEST IFSC codes). Never put a real supplier list or real bank details here.

acc2-supplier-owner-file.csv (CRLF): the owner's file shape. Rows:
  TST-S-001 valid, two hotel links, bank details (arrive unverified)
  TST-S-002 kind channel, state as a GST code, two services, no bank
  TST-S-003 no GSTIN, PAN only, bank details
  TST-S-004 GSTIN state 07 but state Rajasthan (08): gstin_state_mismatch
  TST-S-005 PAN differs from the GSTIN's PAN (gstin_pan_mismatch); unknown hotel ID
  TST-S-001 again: duplicate_in_file (both rows refused)
  TST-S-007 no name: name_required
  TST-S-008 name differs only by "Hotels"/"Hotel" from TST-S-001, same city:
            similar_name_city warning once TST-S-001 is stored
  TST-S-009 bank holder and IFSC without bank name/account: bank_incomplete
  TST-S-010 unknown kind and service: kind_invalid, service_types_invalid
acc2-tally-sundry-creditors.csv (UTF-8 BOM, CRLF): a TallyPrime ledger list
  of the Sundry Creditors group, with a Services column added by Accounts.
  GUID is the source reference; "Under" is not imported. tst-guid-0001 has
  the same GSTIN, PAN and bank as TST-S-001 (same_gstin/same_pan/same_bank
  warnings when the owner file is already applied).
