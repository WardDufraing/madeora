<!-- One change per pull request. Feature branches target main; only a release pull request from main targets production. -->

## Summary

Before:

After:

## Linked requirements

<!-- Build-plan step, spec sections (docs/product/...), architecture.md sections, ADRs. -->

## Testing evidence

<!-- Commands run and their results: format, lint, typecheck, unit tests, build, E2E, RLS where relevant. -->

## Independent review

<!-- Verdict (PASS / CHANGES_REQUIRED), findings and how each was handled. An AI review is not a human approval. -->

## Risks

## Migration and rollback

## Checklist

- [ ] Product specification unchanged (`docs/product/` untouched; the Spec guard check is green)
- [ ] Tests added or updated for the changed behaviour, and passing
- [ ] Security and privacy checked (no secrets, Home isolation and permissions enforced server-side)
- [ ] Independent reviewer verdict recorded above (PASS on the final diff)
- [ ] Owner approval (Ward merges; Claude never merges or deploys)
