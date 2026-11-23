# Tally file and matching upload — design notes (Accounts phase 3, track U, 13 Nov 2026)

Contract 7, 13, 14 and 15 screen 7. Synthetic content only in every 21st.dev query.

## 21st.dev calls

| Query | What came back | Adopted? | Why |
|---|---|---|---|
| `import preview` | Preview Card, Interactive List Preview, Chat Preview, Hover Preview | No | All hover/visual previews; the file preview here is a count summary plus two plain tables (goes in / left out with the fix). |
| `file dropzone` | File Dropzone (type and size validation), Illos Upload Dropzone, Halo Dropzone, Dropzone | Partly | Took the client-side type and size check with a plain message before upload (XML only, ≤ 10 MB). Kept a native file input styled like the existing supplier import (no drag-only target, no animation) so keyboard and screen readers work unchanged. |
| `file upload` / `file upload preview` (lead's call, shared) | File Upload with Preview, Image Preview Dropzone, Upload Advanced | No | Image thumbnails and progress bars do not apply to a Day Book XML. |

## Adaptations

- "Make Tally file" mirrors the Phase 1 CSV export form (same fields, same refusal summary) with two buttons: "Show what goes in" (secondary, the R-C2 preview) and "Make Tally file" (primary). "Include again" reveals a required reason.
- The preview groups left-out records by reason with the fix in words and a link to Tally ledger mapping when a ledger or voucher type is missing.
- Files made: one list for XML files and CSV exports, a "Tally file" / "CSV export" badge (icon + word), left-out count and the include-again reason.
- Matching: upload → plain summary per outcome → "Review and apply" page with outcome filter links (counts), Tally amount beside the CRM amount, Apply bound to the proposal hash, Cancel.
- Tally party name field for the customer page, with a pure mirror of the 1..100 character, no-control-character rule.

## Checked

1280 px and 375 px (no page-level sideways scroll), preview and make-file presses, refusal focus on the include-again reason, no console errors from these pages.
