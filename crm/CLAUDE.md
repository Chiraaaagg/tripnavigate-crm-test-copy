@AGENTS.md
@../docs/implementation/current/standing-rules.md

## Owner design requirement (1 October 2026)

For every UI design task, use the connected 21st.dev tool/connector. This applies to all internal/admin and frontend screens, states, responsive layouts and visual templates. Read `../docs/implementation/operations/cloud-project-context.md` and `../docs/implementation/current/phase-3-ux-brief.md`, and pass their design and content rules to all sub-agents. One agent owns the shared design system. Make screens neat, gently playful, accessible and easy to scan; write precise action labels and honest status/repair text. Use synthetic data in design prompts; never send secrets or customer documents. Record actual tool use. If unavailable, report the design blocker and continue independent backend/tests; do not silently substitute. Backend logic does not require a UI design call.

For connection and business inputs, read `../docs/implementation/operations/cloud-project-context.md` and the current phase handoff. Ask for secret-store locations/configuration, never secret values in chat. Inspect the current branch and CI before assuming a phase is complete.

Owner update, 4 October 2026: use short 21st.dev component searches, normally one to three words, such as `travel`, `dashboard`, `playful` or `user-friendly backend`. Do not use a full project specification as a search query. Read the installed caveman skill in every sub-agent for concise chat; write code and persisted documents in normal prose.

## Ownership update (6 October 2026)

The owner delegated Bitrix integration/sync, operator nomination, Supabase/Vercel management access, integration credential replacement and additional assignee mappings to their team. Read ../docs/implementation/operations/integration-team-checklist.md. Product agents must not modify integration-owned source/migrations/configuration without coordination. The next product scope is Accounts review plus customer receipts; read ../docs/implementation/history/contracts/phase-5a-readiness.md. Policy answers and an independently reviewed bounded contract precede its implementation prompt. Do not follow archived integration work orders.

## Ownership update (8 October 2026)

On 8 October 2026 the owner transferred the Bitrix integration (sync source, integration migrations, intake configuration, the scheduler, sync operations and integration credential setup) to the TripNavigate Claude team. The earlier delegation to the owner's integration teammate has ended; main (via PR 13) is treated as the complete handover. Every hosted database write, Vercel production change, environment change and switching sync on still needs the owner's explicit approval in chat for the exact listed steps. Current work order: ../docs/implementation/current/work-order.md. The 6 October section above is kept as history.

## Owner communication rule (8 October 2026)

The owner is not a programmer. Every message to the owner (from the lead or from any agent whose output reaches the owner):

- Uses plain everyday words. No code, file paths, commit IDs, function names or jargon (CI, migration, RLS, RPC, evidence, SHA, worktree, schema, token, Vault, cron, types, tag, rebase). If a technical word is unavoidable, explain it in brackets in under ten words.
- Starts with one line saying what is happening now.
- Lists anything needed from the owner as numbered items: what, why (one sentence), click-by-click steps, what to reply, and the recommended answer so the owner can reply "OK". Prefer yes/no questions. At most five asks per message.
- Never asks for secret values in chat; says where to save them and how.
- Keeps technical detail in repository docs, not chat.
- Approval requests are titled "APPROVAL NEEDED: <plain name>" and say what changes, what staff will notice, how long it takes, how to undo it, and end with "Reply APPROVE to go ahead".
- Before any live database change, confirm a Supabase daily backup from the last 24 hours exists (`supabase backups list`, pinned CLI) and say its date and time in one plain line. The live project is on Supabase Pro (daily backups, 7-day retention); the owner retired the Mac nightly copy on 24 October 2026. If there is no recent backup, say so and what could be lost.

Current work order since 8 October 2026, night: ../docs/implementation/history/work-orders/claude-work-order-2026-10-08-night.md (replaced on 9 October 2026 by ../docs/implementation/current/work-order.md).

## Testing gate (26 October 2026, owner decision)

The owner decided on 26 October 2026: "this time we will be using GitHub testing and not Colima." The merge and release gate is GitHub Actions `ci.yml`, run on a public test copy of the code that holds only `crm/` and `.github/` (see ops/public-mirror/README.md in the private repository). It runs on the exact head commit, all required jobs must be green, and the tree hashes of the public commit must match the private commit; record both in the pull request. The checks that need a base branch (edited-migration diff, whitespace) run in the private repository. Everything else in the merge rule stays. The 9 October Colima gate is replaced.

## Standing rules (9 October 2026)

Every session and every subagent working on TripNavigate reads and follows `../docs/implementation/current/standing-rules.md` first (owner instruction, 9 October 2026). Every subagent prompt includes: "Read and follow docs/implementation/current/standing-rules.md first."
