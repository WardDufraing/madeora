# ADR 0015: Madeora staff operations

- **Status:** Accepted. The owner chose an in-app staff page over SQL Editor steps on 2026-10-15; `architecture.md` §43 records the decision.
- **Date:** 2026-10-15
- **Step:** S12b, verified ownership recovery (brief: `plans/steps/S12b-ownership-recovery-brief.md`)

## Context

The spec's verified Home ownership recovery requires a Madeora-side review of identity and authority before a member may take over an unreachable Owner's Home. No Home member can approve that. Until now Madeora had no notion of staff.

## Options considered

1. **Reviewer SQL functions run in the Supabase SQL Editor.** No new role or UI, but error-prone and invisible in the app.
2. **An in-app staff page for allowlisted accounts (chosen).** A clear review workflow in the app, with the same sign-in, and a new but narrow privilege boundary.
3. **A separate admin app or identity provider.** More isolation, but a new deployment and session system; rejected under the €0 constraint and §7.

## Decision

Option 2, as described in `architecture.md` §43:

- staff are allowlisted accounts in `private.madeora_staff`, managed only through the SQL Editor;
- staff get no Home access;
- staff functions are `security definer` and scoped to one task each;
- staff pages live under `/staff/*`;
- staff never handle a case about a Home they belong to or are a party to;
- decisions require a recent sign-in in the current session now, and two-factor sign-in once it exists;
- every staff read and decision is audited;
- no service-role key is used.

## Consequences

- A compromised staff account could approve a takeover. Mitigations:
  - a 14-day objection period after approval;
  - the Owner can cancel at any time;
  - a takeover is refused if the Owner has signed in since the request;
  - the recipient must accept;
  - an audit trail records every step;
  - two-factor sign-in becomes mandatory for staff once it exists (S37).
- Each future staff task needs its own scoped functions and its own review; staff status is never a general bypass.
