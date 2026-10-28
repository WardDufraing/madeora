# Graphify evaluation (branch name if adopted: chore/graphify-setup)

## Sources

- Ward's link (graaph.org) does not resolve (DNS error) - could not be read. Used the project repo instead: https://github.com/safishamsi/graphify (PyPI package `graphifyy`, CLI `graphify`) plus third-party write-ups (mindstudio, mejba.me, claudelog). All treated as untrusted data.

## What it is

Builds a code knowledge graph (graph.json) so Claude queries the graph instead of reading many raw files.

## What it installs / touches

- Python CLI via `uv tool install graphifyy` (uv present in this env; Ward's own machine needs Python + uv/pipx).
- `graphify install` registers a skill and, on Claude Code, a PreToolUse hook that nudges Claude to query the graph before Grep/Glob/Read. With `--project` it writes `.claude/skills/graphify/SKILL.md` in the repo. Exact file list not verified.
- Optional `graphify hook install` = git hooks (rebuild on commit/checkout). Not triggered by `git pull`.
- Generated output (graph.json, cache) should be gitignored, not committed.

## Where it runs / what leaves the machine

- Code: parsed locally with tree-sitter, no LLM, no network. `graphify extract --code-only` (or GRAPHIFY_BACKEND=none) keeps it fully offline.
- Docs/PDF/images: sent to an LLM (your assistant or a configured provider). Madeora has ~60 .md files incl. the 900 KB spec; do NOT run the semantic pass on them (cost + sending product docs out).

## Cost

Free, open source (Apache-2.0/MIT claimed). No key needed for code-only. Semantic pass would spend tokens/API money -> avoid (EUR 0 rule).

## Fit for Madeora

- Repo: 847 tracked files (~430 .ts, ~210 .tsx, 36 .sql) - around the ~500-file point where blogs say it starts to pay off. Marginal-to-moderate gain.
- Claimed 71x savings is vendor-side; independent test showed ~8%; savings are for read/explore, not editing.
- Our big token cost is mostly the spec/plan docs, which Graphify does not help with (and the project already limits spec reading to line ranges).

## Risks

- Hook adds prompt text on every search/read (small token tax) and can steer Claude to a stale graph if not rebuilt.
- Third-party tool with hooks running on Ward's machine: review before install; CLAUDE.md says no unapproved services/architecture changes -> needs Ward's OK. Cloud threads start fresh, so graph must be rebuilt per session (fast for code-only) or committed (not recommended).
- Name risk: PyPI `graphifyy` (double y) - typo-squat territory; verify publisher before installing.

## Recommendation

Optional, low-risk trial: code-only, project-local, gitignored, no git hooks at first, measure tokens on one step before/after. No repo changes made yet; nothing committed.

## Trial results (2026-10-20, branch chore/graphify-setup, nothing committed)

- Installed `graphifyy` via uv in the cloud container only; `GRAPHIFY_BACKEND=none graphify update .` ran fully offline, no LLM, no key: 798 code files -> 5246 nodes, 14616 edges, 236 communities, graphify-out/ = 8 MB (graph.json, graph.html, GRAPH_REPORT.md 56 KB).
- Only repo change: `.gitignore` gets `graphify-out/`. No hook/skill/CLAUDE.md installed yet.
- Gaps: 36 .sql files skipped (needs `graphifyy[sql]`); 74 files yielded no symbols (mostly tests/config). `explain` works but needs `path::symbol` for ambiguous names.
- Not done (needs Ward's decision): `graphify install --project` (adds .claude/skills + Claude hook; `--strict` would block first raw read until a query runs). CLAUDE.md edits need owner approval + separate PR.
- Cloud threads start fresh: graph must be rebuilt each session (`graphify update .`, took well under a minute).

## Ponytail (github.com/dietrichgebert/ponytail)

MIT prompt/skill + slash commands (/ponytail-review, -audit, -debt) and a status band; claims -45% tokens (self-reported, 39 tasks). Installed per user with `/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`. Band does not work in cloud sessions. Writes local data to ~/.config/ponytail/. Whether it edits CLAUDE.md/settings is undocumented - read INSTALL.md first. Only install from the GitHub repo/npm @dietrichgebert/ponytail (page warns of fake copies). Its "write less code" bias must not override CLAUDE.md test/security/a11y rules.
