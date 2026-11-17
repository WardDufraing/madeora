# S49 independent review: release readiness (docs only)

Scope: `docs/release-readiness.md` (new, 82 lines) and `plans/steps/S49-brief.md` (new). Checked against `docs/production-setup.md`, `docs/github-setup.md` D, `docs/provider-cost-register.md`, `docs/email-setup.md`, `docs/file-storage.md`, `vercel.json` and `CLAUDE.md`. Line numbers refer to `docs/release-readiness.md`.

**Verdict: CHANGES_REQUIRED**

Counts: BLOCKER 0, HIGH 4, MEDIUM 7, LOW 4.

The structure is complete (decisions, release checklist, staging, monitoring, backup drill, GDPR, incident, follow-ups) and mostly consistent with the existing guides. The problems are internal contradictions around the "no backups" decision, a missing gate for real user data, an EU-only decision that cannot be carried out from the document, and monitoring claims that Vercel Hobby cannot meet.

## Findings

### HIGH

**H1. Checklist item 3 contradicts decision 3 (line 21 vs line 9).**
Decision 3 says no backups exist. Checklist item 3 says "A backup exists from today before any migration that changes or drops data". On Supabase Free this is impossible, so the item cannot be satisfied. Reviewers will either skip it or the release will be blocked. Remediation: make the item conditional, for example "While no backup exists (decision 3): production holds demo data only, so destructive migrations are accepted as data loss. Once backups exist: verify a backup from today first."

**H2. No explicit gate between demo data and real or beta-tester data (lines 9, 60-75, 87-88).**
Decision 3 says production may hold "demo or beta-tester data" with a written warning. This conflicts with several existing rules:

- `production-setup.md` says to use demo data "until the release-readiness/privacy decision permits real household data" and to keep sign-up closed until a product/privacy decision.
- `CLAUDE.md` (backup strategy C) says development backups do not authorize production "without an explicitly approved, tested database and R2 recovery strategy".
- The privacy notice and terms are listed only as a later "new small step". GDPR Art. 13 requires the notice at collection.
- The "written warning" is not defined or placed anywhere.

Remediation: add a "Real-data gate" section. Before sign-up opens to anyone outside demo accounts, require (a) the privacy notice and terms live, (b) the data-loss warning shown at sign-up, with its text drafted, (c) an owner-approved recovery position (an explicit, recorded acceptance of "no recovery" in an ADR, since `CLAUDE.md` otherwise blocks it), and (d) the Hobby commercial-use question settled (see M3). Alternatively state that production stays demo-only until backups exist.

**H3. "EU hosting only" is recorded as decided but is not actionable and is partly unverified (line 64, line 12).**

- `vercel.json` sets no function region. Vercel's default is a US region (iad1). The line "Vercel functions in an EU region" has no owner step, so personal data is currently processed in the US. Add a concrete step (set the region, for example `fra1` or `cdg1`, in project settings or `vercel.json`) and add it to the checklist.
- R2 jurisdiction is fixed at bucket creation and uses a different endpoint (`<id>.eu.r2.cloudflarestorage.com`). `production-setup.md` section 8 and `file-storage.md` show only the default endpoint and never mention a jurisdiction. State whether the existing production bucket is EU. If it is not, it must be recreated before real data.
- Resend is already Ireland (`email-setup.md`), but the document says "Resend EU region" as a to-do. Mark it done.
- Trigger.dev, Cloudflare Turnstile, Google and Vercel's edge network are not covered, and no region is stated for them. "EU only" cannot be literal for Turnstile and the Vercel edge. Reword to "data at rest and processing in the EU where the provider offers it" and list remaining third-country transfers with their mechanism (SCCs or the EU-US Data Privacy Framework) in the privacy notice. Verify Trigger.dev's region options.

**H4. Monitoring plan assumes capabilities Vercel Hobby does not give (lines 40-41, 68).**
"Weekly log look" at Vercel logs is not workable. Hobby keeps runtime logs only for a very short window (about an hour, to be verified), so errors from a week ago are gone. The same applies to the proposed "application logs 30 days" retention. Vercel Observability on Hobby is also limited. Remediation: state the real Hobby log retention (verified on the vendor page), then either (a) drop the weekly look and rely on alert-driven checks, (b) route structured logs to a free sink (needs owner approval under the observability strategy) or (c) rewrite the retention proposal so it does not promise 30 days of logs that Vercel does not keep.

### MEDIUM

**M1. Incident 72-hour rule is stated incompletely (line 76).**
Under GDPR Art. 33 the controller must notify the supervisory authority within 72 hours of becoming aware, unless the breach is unlikely to result in a risk to individuals. Art. 34 requires notifying data subjects when risk is high. The text drops the "unless unlikely" exception and the "becoming aware" trigger, and does not name the authority (it depends on Ward's country, probably the Dutch AP). "Ward is the contact until a processor/controller arrangement is decided" is confusing: Ward is the controller. Also add:

- an internal breach register, which Art. 33(5) requires even for breaches that are not reported;
- that processors (Supabase, Vercel and others) must tell the controller without undue delay;
- that children's and guardian data raise the risk assessment.

Keep the "lawyer to check" caveat.

**M2. Staging decision conflicts with `CLAUDE.md` without recording the deviation (lines 30-32).**
`CLAUDE.md` says dedicated staging "becomes required at the release stage" and that promotion needs "staging migrations/RLS/integration/smoke validation". The document decides "none" but does not say that this deviates from `CLAUDE.md`, which can only change by owner-approved PR. Remediation: add an ADR or a note, and mention that `CLAUDE.md` still needs amending (separate PR). Also make the rehearsal actionable. Give the commands or the doc to follow (local stack with `supabase db reset` and seed, apply the new migration, run the RLS tests and the smoke list). Say what is covered and what is not: a local stack has no production-shaped data and no real Auth or SMTP.

**M3. Vercel Hobby terms are reduced to "no charging, no ads" (line 7).**
Hobby is limited to personal, non-commercial use. Inviting outside beta testers' households is arguably not "personal" use. Vercel may restrict or suspend a Hobby account on a violation. Remediation: say that the beta is limited to a small known group (family and friends), re-read the current Vercel fair-use policy before opening sign-up and record the date, and name the fallback (move to Pro or another host, with a budget decision) if Vercel objects. Also note the GitHub free plan terms used in `production-setup.md`.

**M4. Alert mechanisms are asserted as fact and not verified (lines 40-45).**
"Vercel email on failed deployment", "Supabase email for usage warnings", "Trigger.dev failure email" and "Resend email" for bounce and complaint rates are stated without a verification mark. Only the uptime row says "to verify". Whether these alerts exist on free plans, and what they trigger on, is unconfirmed. `CLAUDE.md` requires practical alerting for critical failures. Remediation: add a "verified on <date>" column or a one-time setup checklist ("enable X in Y and confirm a test alert arrives"). Replace the "Monthly reminder" (no owner or mechanism) with a calendar entry or a recurring issue.

**M5. Supabase Free auto-pause is a production-outage risk and is not monitored (lines 40-45, 51).**
A pause after a week of inactivity takes the app down for beta users, and `production-setup.md` only says to restore after the fact. The monitoring table has no alert for it. Remediation: the uptime check should call a health endpoint that touches the database, which also keeps the project active. Say so, and note that the uptime tool's terms must allow this use. Add "project paused" to the incident notes as a known cause.

**M6. Restore drill is not feasible under current constraints and the dump handling is unsafe as written (lines 55-58).**

- The drill restores into a "scratch Supabase project", but both free slots are used (line 31) and a Pro-plan scratch project costs money. The document should state that the drill requires the budget, or use a local Postgres or Supabase stack for the drill.
- A monthly `pg_dump` of `public` and `auth` contains personal and child data and password hashes. Add encryption at rest, access limits, a retention and deletion period for the dumps, and that dumps are part of the processing records and the deletion promise. Restoring `auth` into another project also needs a stated procedure, because it has Supabase-managed pieces.
- "24 h data loss" with a monthly dump does not hold, because only the paid daily backup gives 24 h. Say so.
- The R2 drill ("restore one deleted test object") needs versioning, which is undecided, so the drill cannot run yet.

**M7. Existing docs left stale or not updated (whole step).**
`docs/provider-cost-register.md` line 28 still says "staging (S49) will need one paused or a paid plan". It should record the decisions (staging none, Hobby non-commercial, R2 card exception from line 34) and add the Vercel Hobby fair-use and EU region entries. `production-setup.md` line 8 refers to the "release-readiness/privacy decision" and should link to the new real-data gate. `plans/roadmap.md` was not checked as part of this diff and should be updated if S49 is tracked there. The brief says cost-register rows are "not done yet", but the stale sentence is a doc correction, not a new row.

### LOW

**L1.** Rollback (line 28): on Hobby, Instant Rollback only goes back to the previous production deployment. Mention this. Also note the expand/contract rule must hold, or the rolled-back app can break against the migrated schema.

**L2.** Line 67 "S45-era privacy exports" is vague. Name the feature (personal and Home exports, `privacy-export-build`) and link `docs/staff-operations.md` or the runbook.

**L3.** Line 66: "Accept each vendor's DPA" should be a checklist item with a date and a place to record it. Add an Art. 30 record of processing and, if applicable, a DPIA note, since the product processes children's data. This stays in the lawyer-check caveat.

**L4.** Cost-rule wording: "free plans only" (line 8) sits next to the owner-approved R2 payment card (cost register line 34) and the paid domain. Add one sentence listing these as the approved exceptions so readers do not think the register was broken. The "Decisions (Ward ...)" heading should also match the owner naming used in other docs.

## Explicit checks

| Check                                                                                            | Result                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Done-condition items present (checklist, staging, monitoring, backup drill, incident, decisions) | Yes, but H1, M2, M6 limit usefulness                                                       |
| Release PR checklist matches `github-setup.md` D and `Release source`                            | Yes                                                                                        |
| Backup claims honest (no PITR or Free-tier backup claim)                                         | Yes in sections 0 and 4, contradicted by H1                                                |
| GDPR claims                                                                                      | Hedged and lawyer-checked, but H3 and M1                                                   |
| `CLAUDE.md` consistency                                                                          | Conflicts H2 and M2                                                                        |
| Product specification untouched                                                                  | Yes, diff is `docs/release-readiness.md` and the S49 brief only                            |
| Docs-only path rule                                                                              | `docs/` and `plans/` paths follow the normal branch and PR flow; no code or config changed |
| Secrets in the diff                                                                              | None                                                                                       |

## Remaining risks

Live-data launch without recovery, EU data residency not actually in place (Vercel region, R2 jurisdiction), and monitoring that does not retain logs.

## Outcome (implementing thread)

All four HIGH findings fixed in `docs/release-readiness.md`: H1 conditional backup item; H2 new "Real-data gate"; H3 EU checklist (Vercel region, R2 jurisdiction, Resend done, Trigger.dev to verify) and softened "EU only"; H4 Hobby log retention no longer promised. MEDIUM M1 to M6 addressed in the same file (incident wording, staging deviation note, Hobby fair use in the gate, alert verification, Supabase pause, drill feasibility and dump handling). M7 partly: the stale staging sentence in the cost register is fixed; linking `production-setup.md` and the roadmap is left to the follow-up steps. LOW L1 to L3 addressed; L4 not done. Fixes checked by the implementer; no second full review round, per project rule.
