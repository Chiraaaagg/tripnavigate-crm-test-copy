# Synthetic import samples (voice-note batch, 24 October 2026)

Made-up data only: every name, phone, email, address, ID and GSTIN here is
invented for tests (example.test / example domains, TST- IDs). Never put a
real hotel or customer list in this folder.

| File | What it shows |
|---|---|
| `hotels-sample.csv` | CRLF, quoted commas, a doubled quote, a cell over two lines, an unknown column (Phone), a bad star rating, a repeated ID, a row without ID that shares a name with another, an empty name, an inactive hotel |
| `customers-sample.csv` | UTF-8 BOM (Excel "CSV UTF-8"), state names and codes, yes/no GST answers, a GSTIN whose state does not match, invalid phone/email/PIN, a repeated ID, an unknown type, a row without ID that shares a name |
| `formula-sample.csv` | A cell that starts like a spreadsheet formula: the whole file is refused |
| `missing-column-sample.csv` | No City column: the mapping is refused before anything is staged |
