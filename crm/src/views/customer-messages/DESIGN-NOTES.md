# Customer messages screens — design notes (Accounts phase 3, track U)

Contract §15 screens 1–4 (Book now language and WhatsApp number, Deal page
"Messages to customer", Purchase "Customer voucher" and Flight "Boarding
passes", Settings › Customer messages). Built 13 November 2026 against the
typed adapter in `types.ts` and preview data (`/preview/acc3-messages-*`);
track A's TypeScript module did not exist yet.

## 21st.dev calls (component search, synthetic queries only)

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `message log` (lead, before the fork) | Log Viewer (two), Audit Log, Message Scroller, Message Thread | Partly | Audit Log's row shape (title, actor/time line, status tag at the right) became the message row: type · channel · language, "To … · time · With file", status badge right. No streaming, filters or follow mode — the card holds at most 100 rows. |
| 2 | `notification settings` (lead) | Notification Settings Field, Settings Card, Preferences Matrix, Channel Selector, Frequency Select | Partly | The Preferences Matrix (event rows × channel columns) shaped Settings › Messages and channels: one row per message type, an E-mail cell and a WhatsApp cell. Checkboxes were replaced by a status word plus a "Turn on / Turn off" dialog with a reason (contract A7 needs a reason and row version per switch). |
| 3 | `file upload preview` (lead) | File Upload with Preview, Image Preview Dropzone, Upload Advanced, FileUpload, upload | No | Drag-and-drop and progress bars add weight; the CRM's existing private-file pattern (button → dialog → native file input, then a file line) is used for the voucher and boarding-pass uploads, matching Purchase and Flight. |
| 4 | `device list` (lead) | Item Action List, Item List with Actions, Key Value List, Notification List, Account List Item | Partly | Item Action List (title, description, one action at the right) shaped the pilot Deal list rows (reference, "Added by … on …", Remove). Key Value List shaped the Language / WhatsApp / E-mail facts on the Deal card. |
| 5 | `message status` | Message With Header And Delivery Status, Message Queue, Status (pulsing dot), Chat System Message | Partly | The delivery-status idea (sent → delivered → read under each message) became the status word set Waiting / Sent / Delivered / Read / Failed — reason / Stopped — reason / Skipped — reason, shown with the existing StatusBadge (icon + word). The pulsing dot was not used (no colour-only or animated status). |
| 6 | `toggle list` | Interactive List Preview, Animated List, Interactive List, Category List | No | All hover- or animation-led; switches here are deliberate, reasoned changes, so a plain list with a dialog per change is used. |
| 7 | `template preview` | Preview Card, Live Preview Form, Chat Preview, Interactive List Preview | Partly | Chat Preview's "message bubble" became the grey text block showing each template's subject and body with synthetic values, one per language, inside a native `<details>` per message type (keyboard and screen-reader friendly, no script). |
| 8 | `language select` | Select (originui), Select (native), Select, Select (language selector) | No | Two languages only, so radio buttons (always visible, one press) are used instead of a select. |

## Adaptations and rules applied

- One primary action per panel: "Ready for customer" (voucher), "Upload boarding pass" (primary only when due), "Change language or channels" stays secondary on the Deal card because the card is mostly read.
- Every status is an icon plus words (StatusBadge); no status by colour alone. Failed and skipped rows always carry the reason in words.
- No amounts on the Deal card or the task panels (contract 5.10, LD9); Purchase and Flight see only the send state per channel.
- Refusals keep typed input (DeskDialog / HandForm pattern from the Accounts desk kit); the field a refusal names is marked and focused.
- Blocked actions stay visible with `aria-disabled` and one short reason (WhatsApp switch before both templates are approved; uploads before supplier confirmation or ticket confirmation).
- Hindi template bodies are placeholders labelled "Hindi text from track A's templates.ts"; the footer line is the frozen Hindi STOP text. The view takes preview strings as props, so track A's list replaces them without a view change.
- Checked in the preview gallery at 1280 px and 375 px: no page-level sideways scroll on any of the 39 states, keyboard path into and out of the preferences dialog (focus lands in the dialog, Escape returns it to the opener), no console errors.
- Tailwind note: the running dev server had not picked up the new `@source '../views/customer-messages'` line, so only classes already generated elsewhere are used (e.g. `md:grid-cols-3` instead of an arbitrary grid template).
