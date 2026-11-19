# Accounts phase 2: Tally mapping, Accounts switches, bell sound and pop-ups (Track E, 11 Nov 2026)

Business rules come from the frozen Accounts phase 2 contract (sections 8.1, 8.4, 8.5, 11.11–11.13, 13.5; owner answer Q12; addenda L1–L3). Every screen reuses the CRM kit (`src/components/ui/*`) and the Phase 1 desk kit (`src/views/accounts-desk/desk-kit.tsx`: one dialog per form, request id renewed only after success, a refusal keeps the dialog open with the typed values and focuses the named field). No new dependency.

## Screens and where they live

| Screen | Files | Preview states |
|---|---|---|
| Settings › Accounts › Tally mapping (11.11) | `mapping.tsx`, `labels.ts`, `types.ts` | `acc2-settings-tally-mapping*` |
| Settings › Accounts: customer documents and refunds switches (11.12) | `../accounts-desk/settings.tsx` | `acc2-settings-accounts*` |
| Bell settings: sound and pop-ups (11.13, 8.4, 8.5) | `../notices/bell.tsx`, `../notices/provider.tsx`, `../notices/popup.ts`, `../notices/types.ts` | `acc2-settings-bell-*` |

## Interaction decisions

- Tally mapping: rows grouped as Accounts read their day book (Money in, Money out, Customer documents, Supplier documents); each row shows the record and service, the three names ("Not set" in words when blank, plus a "Mapping missing" badge with icon), the last change and one "Edit" button named after the row. The missing count sits at the top with two pressed toggle buttons "All rows / Missing only" (client-side: the list is at most about 60 rows). The edit dialog has the three names (optional, empty clears) and the reason (10–500 characters); the database decides every rule (no leading = + - @, no control characters, lengths). A note says a mapping change never marks exported records as changed and that nothing is posted to Tally.
- History: D1 returns no history rows (gap reported). The screen shows "Last change: date · name" from the row and, when a read provides `history`, a "History" dialog (newest first, field, old → new, reason).
- Switches: the Phase 1 pattern (current value in words, "Switch on / Switch off" button with a reason; "Not known" never reads as Off and shows no switch). The documents switch text says to keep it off until the CA confirms the names and numbering.
- Bell settings ("Sound and pop-ups"): two sections, each with its state in the heading ("Sound: on", "Pop-ups: on") and one plain button that says what it does ("Turn sound off", "Turn pop-ups off"), plus "Test sound". The browser's side is one line with icon and words: "Pop-ups on in this browser", "Blocked by this browser — allow notifications for this site in the browser settings", "Not supported on this device", or "This browser has not been asked yet…" with "Allow pop-ups in this browser" (a click, so the browser may ask). Results are announced in a status line.
- Pop-ups (provider): urgent-tone notices only (an escalated receipt reminder never pops up), only from the sound leader tab, never while the CRM tab is visible and focused, more than three → one "{n} urgent notices" pop-up; text is the reference-only notice text; click focuses the tab and opens the notice's page. Permission asked once per browser on the first pointerdown/keydown while pop-ups are on (localStorage `tn-notice-popup-asked`, every access in try/catch); denied is never asked again. No service worker, no push. The policy sits in `popup.ts` as an adapter with the contract 8.4 signature until track D's `popup-policy.ts` / `popup-browser.ts` land.
- The bell state stays in the provider's `useSyncExternalStore` store (no React context around the page); bell reads stay on GET routes.
- Preview fix: the bell now applies the preview's starting view (`settings`, `history`) when it opens; before, the store was published after the first render so the gallery always opened the inbox (also affected `acc-bell-sound` and `acc-bell-history`).

## 21st.dev calls

Tool: `search`, type `component`, limit 5. Short synthetic queries only; no customer, money, ledger or company data was sent.

| # | Query | What came back | Adopted? | Why |
|---|---|---|---|---|
| 1 | `mapping table` | Records Table (theshanelevine), Table (originui), Column Visibility Table, Table (micka_design), Inventory Table | Idea only (Table, originui) | Plain bordered table with stacked phone rows from the kit; no sticky column, selection, sorting or colour meters (status must be words). |
| 2 | `audit history` | Audit Log (corr), Audit Log Table, Audit Log With Icon Tiles, Illos Audit Log Panel, Invoice History Table | Idea only (Audit Log) | History as a newest-first list: who, when, field old → new, reason. No avatars, IP or severity colours, no illustration. |
| 3 | `notification settings` | Notification Settings Field (shadcnspace), Notification Settings Card, Preferences Matrix, Channel Selector, Frequency Select | Idea only (Notification Settings Field) | One row per channel with title and description; instead of an instant switch, a button that names the change (the change is saved per person and can fail: "Could not save — try again"). |
| 4 | `permission prompt` | Alert Dialog (shadcn), Permission Grant, Snippet, Alert Dialog (originui), Prompt Box | No | The browser shows its own permission prompt; a CRM pre-prompt dialog would add a step. The settings show the browser state in words and one "Allow pop-ups in this browser" button. |
