# Acceptance matrix (S48)

The ten journeys of `docs/product/Project-entry.md` ("First implementation journeys") and the Playwright specs in `tests/e2e/specs/` that walk them. Run them with `pnpm test:e2e` (CI) or `pnpm test:e2e:fallback` (no Docker); see `docs/development.md`.

| Journey           | Spec(s)                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| New adult         | `dashboard.spec.ts` (starter dashboard, keyboard customisation, persistence), `auth.spec.ts` |
| Join Home         | `invitations.spec.ts`, `members.spec.ts`                                                     |
| Shared chore      | `chores.spec.ts` ("the shared chore journey"), `chore-pool.spec.ts`                          |
| Plan dinner       | `meal-planner.spec.ts` ("plan dinner: recipe, plan, transfer ingredients, check off")        |
| Google Calendar   | `google-calendar.spec.ts`, `calendar.spec.ts`, `tests/e2e/google/google-sign-in.spec.ts`     |
| Habit to goal     | `habit-goal-links.spec.ts`, `habits.spec.ts`, `goals.spec.ts`                                |
| Pet care          | `pet-care.spec.ts`, `pets.spec.ts`                                                           |
| Ora change        | `acceptance-ora-change.spec.ts` (guided change, preview, confirm, Undo), `ora.spec.ts`       |
| Shared screen     | `display-pairing.spec.ts`, `display-layouts-lock.spec.ts`                                    |
| Privacy lifecycle | `privacy-lifecycle.spec.ts` (review, export, delete with confirmation and recovery)          |

Cross-cutting acceptance checks:

| Check                                  | Spec                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| axe on every main screen, both themes  | `acceptance-screens.spec.ts` (screen list in `support/screens.ts`)                                              |
| axe on screens with a record id        | the module's own spec                                                                                           |
| axe on auth, child and display screens | `auth.spec.ts`, `child-sign-in.spec.ts`, `display-pairing.spec.ts`                                              |
| Denied states (outsider, plain Member) | `acceptance-states.spec.ts`, plus module specs that name a member without rights (for example `tasks.spec.ts`)  |
| Offline states                         | `acceptance-states.spec.ts` (Tasks: held, never shown as saved), Ora's offline panel (`ora-assistant.test.tsx`) |
