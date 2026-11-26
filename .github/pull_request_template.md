## Summary

What changes, for a reader who has not followed the branch. State the problem,
what triggers it, and how the system behaves after the change.

## Type of change

- [ ] Bug fix
- [ ] New capability
- [ ] Refactor with no behavior change
- [ ] Tests / tooling / CI
- [ ] Documentation

## Testing

Command run and its actual result, at the pushed head:

```bash
npm ci && npm run verify
```

- Build:
- Tests (count and result):
- `npm run openapi:check`:
- Manual observation (if any):

A component passing its own unit tests is not evidence for the UI-to-API-to-engine
path. Name the end-to-end test or the manual path that covers it.

## Contract impact

- [ ] No operation, event or schema changed
- [ ] Operation added/removed/changed (list them and the version decision)
- [ ] Execution event changed (list the schema version decision)
- [ ] `openapi.json` regenerated with `npm run openapi:write`

## Risk and rollback

What can break, who is affected, and the exact revert or rollback step.

## Checklist

- [ ] `main` is the base and no direct push happened
- [ ] No secret, token, private hostname or owner path is included
- [ ] Zero-cost guarantees preserved (`allowPaid` still a literal `false`)
- [ ] Owner-only authorization and data-mode isolation preserved
- [ ] Durable execution invariants preserved (fenced terminal writes, no unfenced settle)
- [ ] Relevant tests added or updated, and they fail without the change
- [ ] Documentation updated where behavior changed
- [ ] Checks that could not run are named, not implied to have passed
