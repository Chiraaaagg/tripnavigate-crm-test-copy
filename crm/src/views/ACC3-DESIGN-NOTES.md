# Accounts phase 3 — design notes (track U)

Contract: `Tripnavigate-docs/implementation/accounts-phase3-2026-11-12/contract.md` §0 (UI rules), §14 (fences), §15 (screens). All 21st.dev searches used one-to-three-word queries with synthetic content only; nothing from 21st.dev was installed or copied (no `get_component` call, no new dependency). Ideas were rebuilt on the CRM kit (`components/ui`, `views/accounts-desk/acc2-kit.tsx`, `desk-kit.tsx`).

Per-feature records (each lists every call, what came back, adopted or not and why):

| Screen (§15) | Notes file | Preview states |
|---|---|---|
| 1–4 Customer messages (Book now language, Deal card, task panels, Settings) | `views/customer-messages/DESIGN-NOTES.md` | `acc3-messages-*` |
| 5, 11 Automatic bills (documents card, Bills to check, Settings › Accounts), daily check | `views/customer-documents/DESIGN-NOTES.md` (Accounts phase 3 section) | `acc3-bills-*` |
| 6 Write-offs | `views/write-offs/DESIGN-NOTES.md` | `acc3-writeoffs-*` |
| 7 Tally file and matching upload | `views/tally-file/DESIGN-NOTES.md` | `acc3-tally-*` |
| 8 Bell › Alerts on this device | this file (below) | `acc3-alerts-*` |
| 9 Rate contracts (Release B) | `views/rate-contracts/DESIGN-NOTES.md` | `acc3-rates-*` |
| 10 Changes after confirmation, add / remove services, history (Release B) | `views/booking-changes/DESIGN-NOTES.md` | `acc3-changes-*` |

## Shared calls made by the lead of track U (13 Nov 2026)

| Query | What came back | Used? |
|---|---|---|
| `message log` | Log Viewer (two), Audit Log, Message Scroller, Message Thread | Idea only for the Deal messages list: one row per send with time, status word and reason; no streaming / follow toggle (not needed). |
| `notification settings` | Notification Settings Field, Notification Settings Card, Preferences Matrix (event × channel checkboxes), Channel Selector, Frequency Select | "Settings Field" row shape (title, one line, one control) adopted for "Alerts on this device"; the event × channel matrix idea passed to the Settings › Customer messages switches (9 types × 2 channels). |
| `file upload preview` | File Upload with Preview, Image Preview Dropzone, Upload Advanced, two plain uploaders | Not adopted: the CRM keeps its existing private-evidence upload (begin / upload / finish) for vouchers, boarding passes and rate-contract files; noted for the task panels only as "show the stored file name and state". |
| `device list` | Item Action List, Item List with Actions, Key Value List, Notification List, Account List Item | "Item Action List" (row + one action) adopted for the device list: label, added / last alert dates, "Remove". |
| `push permission` | Permission Grant, Push Approval Card, Permissions Button, Tool Approval, Access Request Inbox | "Permission Grant" idea (explain reach before asking) adopted as the one-paragraph "what alerts do" text before the "Turn on" button; the browser is asked only after that click. Animated approve / reject buttons not used (reduced motion, one primary action). |
| `active sessions` | Dashboard Activities, tabs, Presence Bar | Not adopted (no session-list pattern returned); the device list stays a plain list. |

## Bell › Alerts on this device (screen 8)

- Third section of the bell settings ("Sound, pop-ups and alerts"), after Sound and Pop-ups, same heading pattern: "Alerts on this device: on / off / blocked / needs Home Screen / not supported / not switched on".
- One state line in words with an icon (never colour alone): unsupported, iPhone needs the Home Screen first, blocked by the browser, off, on.
- One primary action per state: "Turn on alerts on this device" (aria-disabled with one reason when the switch is off, the browser cannot, iPhone is not installed, the browser blocked it, or 10 devices exist), or "Send a test alert" plus "Turn off on this device" when on.
- Device list: label from the browser, "(this device)", added date and last alert date in India time, "Remove" with the device name in its accessible name. Shared-computer warning under the list.
- Nothing is registered and the service worker is not asked for until the person presses the button (contract 8.4; the adapter `DeviceAlertsApi.turnOn` belongs to track D's `push-client.ts`).
- Files: `views/notices/device-alerts.tsx`, `device-alerts-types.ts` (typed adapter of D3 and the push-policy states), `device-alerts-words.ts` (pure, `tests/unit/acc3u-alerts-words.test.ts`); `types.ts` (`NoticeApi.deviceAlerts?`, `preview.deviceAlerts?`), `provider.tsx` (context carries `deviceAlerts`), `bell.tsx` (section and title).
- Checked at 1280 px and 375 px in the preview: no page-level sideways scroll, popover content fits (349 px), keyboard reaches every button, result lines announced (`role=status` / `alert`).
