## What and why

<!-- What changes, and what problem it solves. Link the issue. -->

Closes #

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Contract changed? `npm run contracts:test` passes
- [ ] Behaviour change carries a test (new metrics need a null/empty-input case)
- [ ] Published numbers changed? `docs/methodology.md` updated in this PR
- [ ] Money arithmetic uses BigInt stroops, never `parseFloat`
- [ ] Failures stay visible — no error turned into a silent skip

## Does this change a published figure?

<!-- If yes: what was it before, what is it now, and why is the new one right?
     Say "no" if it doesn't. -->
