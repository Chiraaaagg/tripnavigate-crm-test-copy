# Rate contracts — design notes (Accounts phase 3, Release B, track U)

Screens: contract §15 item 9 — Suppliers › Rate contracts (list, R-E1), one contract (R-E2: details, rate lines, blackout dates, room types, file, history, decisions), Approvals › Rate contracts (tab content), Settings › Imports › Rate sheet (column help and check result) and the Purchase offer form contract block (R-E3 / 9.2). Built 13 Nov 2026 against a typed adapter (`types.ts`) because track E's module did not exist yet. Preview states: `/preview/acc3-rates-*`.

## 21st.dev calls (component search, synthetic queries only)

| # | Query | What came back | Adopted? | Why / how adapted |
|---|---|---|---|---|
| 1 | `pricing grid` | Marketing pricing tiers (olewandowski1 28342, odysseyui 28879, preetsuthar17 3034, diarmuradi 28176) | No | Subscription-plan cards, not a cost table. Nothing for supplier rates. |
| 2 | `editable table` | Editable Data Table (starc007 29311), Table Edit (ruixen.ui 7457), Excel-Style Table (ravikatiyar162 8778), Records Table (theshanelevine 23604) | Idea only | Inline cell editing and spreadsheet selection need sideways scrolling at 375 px and weak keyboard/label support. Adopted the idea of one row per rate line with an "add row" and "copy row" control, but each line is a labelled fieldset card (works at 1280 and 375 px, every input has a label naming the line). Read mode uses the existing `Table stackOnMobile`. |
| 3 | `version history` | Changelog timelines (shadcnui-blocks 28356, shadcnblockscom 2203, saurabh-2607 23363, shadcnstore 28443, dhxwhy 36570) | Idea only | "Earlier versions" is a short vertical list with a left rule, version number, status badge, dates and who decided; no animation. |
| 4 | `price breakdown` | Pricing sections and an ROI calculator (uilayout 6261, mokshithgujjeti 18754, diarmuradi 27098, brijr 7539) | No | Nothing for a night-by-night stay price. The offer block uses the existing "amount aside" look (label above, large figure) plus a native `<details>` "Night by night" list grouped into runs. |
| 5 | `expiry badge` | Expiring Badge (dhxwhy 44855), Count Badge, Timestamp, Status Badge (serafimcloud 521) | Idea only | "N days left" shown as a second StatusBadge with a calendar icon, warning tone within 30 days. No live countdown or animated rim (calm, reduced motion, not colour-only — the words carry it). |
| 6 | `date range list` | Date Range Picker (kuratlielia 35052), HeroUI Range Calendar (18660), Range Calendar With Presets (sean0205 29224), Date Range Calendar (cnippet-dev 25114) | No | Blackout periods are entered as two native date inputs per period (keyboard and phone friendly, no new dependency); a calendar widget adds weight for a rarely used field. |
| 7 | `approval card` | Human-in-the-loop approval cards (theshanelevine 23595, syeddhasnainn 36498, starc007 26580, educalvolpz 23792) | Idea only | Approvals tab uses the existing `ItemCard` with one action ("Review and decide") that opens the contract: the Manager reads every rate line before deciding, so there is no approve-from-the-list button. |

No component code was retrieved (no `get_component` calls); everything is built from the existing kit (`components/ui`, `accounts-desk/acc2-kit`, `accounts/supplier-kit`).

## UI rules applied

- One primary action per screen: list = "Add a contract" (Purchase); contract = "Send for approval" (Purchase) or "Approve contract" (Manager). Return and End are secondary, in their own card, with a reason.
- Status, owner and next step at the top of the contract page (`nextStepText`).
- Unavailable actions stay visible with `aria-disabled` and one short reason (switch Off, no lines yet, own contract).
- Refusals keep typed input; the refused field (including `lines[n].field` hints) is marked and focused; the error summary links to it.
- Status never by colour alone: every badge has words; the overlap and blackout states have titles.
- No page-level sideways scroll at 375 px: tables stack into labelled cards under 640 px; the editable lines are cards.
- Rate contracts are supplier costs: Sales, Flight and Visa get the "not available" state; no selling price anywhere.
