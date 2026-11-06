# Contributing

Small fixes and bug reports are welcome. This project stays simple on purpose, so please open an issue before adding a feature. [What was left out](docs/decisions.md#deliberately-left-out) explains the limits.

## Where to start

| Change | Start here | Test here |
| --- | --- | --- |
| Tracker, queue, retries | `src/client/tracker.ts` | `tests/delivery-races.test.ts`, `tests/collect.test.ts` |
| A cookie banner | `src/client/cmp/` | `tests/cmp-adapters.test.ts`, then [cookie banners](docs/cookie-banners.md) |
| Consent rules | `src/client/consent.ts` | `tests/consent-rules.test.ts`, which must match the table in the [overview](docs/technical-overview.md) |
| Anything sent to Google | `src/server/google.ts` | `tests/collect.test.ts`, `tests/mp-contract.test.ts` |

## Before a pull request

```sh
npm ci
npm test
npm run typecheck
npm run format:check
npx playwright install chromium webkit && npm run test:e2e
```

`tests/fuzz.test.ts` runs the real tracker and collector through random sequences, with a fake Google that fails and stalls, and checks rules that must always hold. After a change to consent, sessions or delivery, run more of them: `FUZZ_RUNS=20000 npx vitest run tests/fuzz.test.ts`. A failure names a seed. Repeat it with `FUZZ_RUNS=1 FUZZ_SEED=123 FUZZ_TRACE=1 npx vitest run tests/fuzz.test.ts`.

A pull request says what changed, why, and how it was tested. A claim in the documentation needs a test or a source. If it has neither, write "Not verified".

`/g/collect` has no public contract. A change to its fields starts from a captured Google tag hit, as described in the [notes](docs/measurement-protocol-notes.md#gcollect).
