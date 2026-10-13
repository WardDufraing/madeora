# Provider cost register

Required by `architecture.md` §23 and `CLAUDE.md` (€0 development budget). Every external service gets a row **before** it is provisioned. Re-check before each deployment and whenever pricing changes. If a service needs a payment card, billing activation, a paid trial or has automatic overage charges, stop and ask the owner.

| Provider       | Used for                     | Plan        | Verified on (source)    | Free allowance | Card or billing needed? | Quotas and overage behaviour | Fallback                       | Status          |
| -------------- | ---------------------------- | ----------- | ----------------------- | -------------- | ----------------------- | ---------------------------- | ------------------------------ | --------------- |
| GitHub Actions | CI                           | Not checked | Not yet (S02)           |                |                         |                              |                                | Not provisioned |
| Supabase       | Auth, Postgres, Realtime     | Not checked | Not yet (S03)           |                |                         |                              | Local Supabase CLI or Postgres | Not provisioned |
| Vercel         | Hosting, previews            | Not checked | Not yet (release stage) |                |                         |                              | Local `next start`             | Not provisioned |
| Resend         | Transactional email          | Not checked | Not yet (S10)           |                |                         |                              | Local mail catcher             | Not provisioned |
| Trigger.dev    | Background jobs              | Not checked | Not yet (S13)           |                |                         |                              | Ask the owner                  | Not provisioned |
| Cloudflare R2  | File storage                 | Not checked | Not yet (S15)           |                |                         |                              | Ask the owner                  | Not provisioned |
| Google Cloud   | Google sign-in, Calendar API | Not checked | Not yet (S08, S33)      |                |                         |                              | Ask the owner                  | Not provisioned |

S01 (monorepo bootstrap) uses only open-source packages from the npm registry and provisions no service.
