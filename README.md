# Madeora

Madeora is a modular personal-life and household coordination application. A person can use it alone or belong to several Homes, with configurable dashboards, modules such as calendar, tasks and chores, meals, recipes and shopping, habits, pets and photos, a Household Display, and the permission-aware assistant Ora.

This repository currently holds only the documentation the build starts from. No application code exists yet.

## Where to start

| File | What it is |
|---|---|
| [`docs/product/Project-entry.md`](docs/product/Project-entry.md) | Product overview. Read this first. |
| [`docs/product/Modules.md`](docs/product/Modules.md) | Module catalogue. |
| [`docs/product/Project-specification.md`](docs/product/Project-specification.md) | Binding detailed requirements. |
| [`architecture.md`](architecture.md) | Technical source of truth: stack, data model, security, operations. |
| [`CLAUDE.md`](CLAUDE.md) | Mandatory workflow and rules for every agent and contributor. |
| [`docs/design/design-decisions.md`](docs/design/design-decisions.md) | Owner design decisions that supplement the specification, with the [styling reference mockup](docs/design/mockups/household-dashboard-light-dark.png). It was written before this repository existed: its `Initial Documentation/` paths mean `docs/product/`, and the website-builder mockup it lists as not for use is deliberately not included. |

## Rules that apply from the first commit

- **The product specification is read-only.** The three files in `docs/product/` must never be edited, renamed, moved, reformatted or regenerated. Changes to them happen in a separate workflow outside this repository.
- `architecture.md` and `CLAUDE.md` change only with the owner's approval, in their own pull request.
- Feature branches merge into `main`. The owner decided (13 October 2026) that production will run from a separate `production` branch, changed only through a release pull request from `main`. Until that change to `architecture.md` lands, its release sections still describe deploying from `main`.
