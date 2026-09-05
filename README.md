# MissionPay Continuity

MissionPay is a continuity transaction layer for autonomous commerce: AI compiles intent,
MissionPay bounds authority, live market adapters supply persisted observations, and Razorpay
Test Mode executes the existing payment flow. Payment and outcome lifecycles remain separate.

## Local setup

1. Install Node.js 20.9+ and PostgreSQL.
2. Copy `.env.example` to `.env.local` and set `DATABASE_URL`.
3. Run `npm run db:migrate`, then `npm run db:seed`.
4. Run `npm run dev`.

The seed uses 1 January 2030 as the simulated demo date. Create the demo mission with an 8 PM
deadline on that date (`2030-01-01T20:00:00+05:30`). All amounts are integer paise.

## Commands

- `npm test` — financial invariant and state-machine tests
- `npm run typecheck` — strict TypeScript validation
- `npm run lint` — ESLint
- `npm run build` — production build
- `npm run db:generate` — generate a migration from the Drizzle schema
- `npm run db:migrate` — apply migrations
- `npm run db:seed` — seed simulated merchants and offers

## API surface

- `GET /api/offers`
- `POST /api/missions`
- `GET /api/missions/:missionId`
- `POST /api/missions/:missionId/reservations`
- `POST /api/reservations/:reservationId/release`
- `POST /api/missions/:missionId/validate`
- `POST /api/missions/:missionId/plan`
- `GET /api/missions/:missionId/plan`
- `GET /api/missions/:missionId/view`

Every financial mutation body includes `expectedVersion`. The server returns `STALE_PLAN` when it
does not match the mission row locked inside the transaction.

## Financial authority boundary

`MissionAuthority` owns `reserve`, `release`, `remaining`, and `validateMission`. It depends on the
`MissionAuthorityStore` interface. `PostgresMissionAuthorityStore` implements that boundary with a
Drizzle transaction and a `SELECT ... FOR UPDATE` mission-row lock. The database also enforces the
aggregate authority check:

```text
reserved_amount + committed_amount <= budget_amount
```

`mission_events` is append-only via a PostgreSQL trigger in the initial migration.

## Mock merchant world (Milestone 2)

`MockMerchantAdapter` uses the existing PostgreSQL merchants, offers, reservations, missions, and
event ledger. Offer price, availability, readiness time, and economic version are current world
state. Reservations keep an immutable snapshot of those terms. A meaningful offer change increments
the offer version and atomically invalidates only stale held reservations and their missions; it does
not rewrite reserved or committed financial authority.

Deadline matching is deterministic and inclusive: `readyTime <= deadline`. For the seeded 20:00
demo deadline, R1 at 19:30 and R2 at 19:45 qualify; R3 at 20:30 does not.

Merchant APIs:

- `GET /api/merchant/offers?category=RESTAURANT&readyBy=...`
- `GET /api/merchant/offers/:offerId`
- `GET /api/merchant/reservations/:reservationId`

The world-change endpoint is available only when the server-side
`MISSIONPAY_DEMO_MODE=true` flag is present:

- `POST /api/dev/offers/:offerId/simulate-change`

Live integration tests require `DATABASE_URL_TEST`, which must differ from `DATABASE_URL`. Prepare a
dedicated Neon test branch with `npm run db:migrate:test` and `npm run db:seed:test`, then run
`npm run test:integration`. The safety runner refuses to fall back to the primary database.

## AI mission planner (Milestone 3)

The planner follows the boundary **AI proposes; MissionPay decides**. The model sees a bounded,
sanitized mission and merchant-offer snapshot and returns a strict structured proposal. The server
then reloads persisted offers and deterministically enforces mission/offer versions, availability,
deadline, category completeness, vegetarian and capacity constraints, and integer-paise budget.
Only the orchestration service can advance mission state or call the merchant/authority layers.

Set `MISSIONPAY_PLANNER_PROVIDER=mock` for the deterministic local demo. For the live server-side
Groq Responses adapter, use `MISSIONPAY_PLANNER_PROVIDER=groq`,
`MISSIONPAY_PLANNER_MODEL=openai/gpt-oss-120b`, and `GROQ_API_KEY`. The existing OpenAI adapter
remains selectable with `MISSIONPAY_PLANNER_PROVIDER=openai`, `OPENAI_PLANNER_MODEL`, and
`OPENAI_API_KEY`. Credentials are never included in compiler input, diagnostics, or API responses.

Planning follows `DRAFT -> PLANNING -> PROPOSED -> RESERVING -> READY_TO_COMMIT`. A failed
multi-reservation attempt releases only reservations created by that attempt and records the
compensation in the append-only event ledger. It does not perform mission repair.

## Minimal mission repair (Milestone 4)

An economic merchant change invalidates affected reservation snapshots without rewriting their
historical prices. Repair follows `INVALIDATED -> REPLANNING -> RESERVING -> READY_TO_COMMIT` and
uses the existing MissionAuthority release/reserve/version locks. Valid unrelated reservations are
preserved. Broken reservations are released exactly once using their immutable snapshot amounts.

Candidate combinations are ranked deterministically by changed-item count, resulting persisted
cost, then stable offer code/ID. For the canonical scenario, C1 and F1 remain held, R1 is released,
and R2 is reserved, producing 730000 paise reserved and 70000 paise remaining.

Repair APIs:

- `POST /api/missions/:missionId/repair`
- `GET /api/missions/:missionId/repair`

POST accepts only `expectedVersion`, plus an optional `Idempotency-Key` header. A failed
release-then-reserve attempt remains non-ready, retains unaffected holds, and records accurate
local authority and append-only audit history. A later fresh repair can retry the missing category
without releasing the old broken reservation twice.

## Demo UI and read model (Milestone 5)

Open `/` or `/demo` for the guided MissionPay presentation. The client creates the mission through
the normal mission API, runs the existing planner, and renders only the consumer-oriented
`MissionView` returned by `GET /api/missions/:missionId/view`. Authority totals, constraints,
available actions, reservation snapshots, current merchant terms, structured explanations, and
the event timeline are derived from persisted server data.

During active states the client polls every 750 ms; stable and failed states reduce polling to four
seconds. Mutation buttons lock while a request is in flight, use expected mission/offer versions,
and never send prices or balances as authority inputs. Payment remains visibly unavailable.

The demo world reset and market-change controls require the server-only
`MISSIONPAY_DEMO_MODE=true` flag. This works in local development and deployed demo environments;
when absent, the mutation endpoints return 404. The reset endpoint restores only the seeded R1 offer through
the economic world-change service; it does not delete missions or bypass invalidation logic:

- `POST /api/dev/demo/reset-world`

## Razorpay test-mode payments (Milestone 6)

Payment authority is server-owned and integer-paise based. A payment order can be created only
from `READY_TO_COMMIT`; the service locks the mission, revalidates every active reservation
snapshot, and derives the amount from persisted authority. The mission then enters
`PAYMENT_PENDING`. A verified checkout callback or signed webhook may move it to `PAID` exactly
once; captured reservations become historical `COMMITTED` rows and the mission's reserved amount
is released while committed amount is recorded. Merchant offer mutations are frozen while
payment is pending.

Required local configuration for real Razorpay Test Mode (never commit these values):

```text
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

The payment endpoints are `POST /api/missions/:missionId/payment-order`,
`POST /api/missions/:missionId/payment-callback`, and `POST /api/razorpay/webhook`. Tests use an
in-process provider; an actual Razorpay checkout requires Test Mode keys and a configured webhook
URL. Merchant distribution, Route transfers, settlement, refunds, and Milestone 7 are not part
of this milestone.

## MissionPay Continuity

The primary `/` experience accepts arbitrary commerce outcomes and compiles dynamic `needs[]`;
the deterministic birthday world remains at `/demo`. Set `MISSIONPAY_MARKET_MODE=live` to use
SerpAPI Google Shopping, or `sandbox` for synthetic and clearly labelled fallback observations.
Live mode never falls back silently when `SERPAPI_API_KEY` is absent.

Location is foreground and consent-based. The primary UI requests browser geolocation only after
the user clicks the location control, reverse-geocodes it to a safe label, and supports manual
override. An explicit delivery destination in the mission prompt takes precedence. Precise
coordinates are omitted from client read models and payment notes; unsupported delivery evidence
is shown as `UNKNOWN` rather than inferred.

Continuity APIs:

- `POST /api/continuity/missions`
- `GET /api/continuity/missions/:missionId`
- `POST /api/continuity/missions/:missionId/replace`
- `POST /api/continuity/missions/:missionId/revalidate`
- `POST /api/continuity/missions/:missionId/issues`
- `POST /api/continuity/missions/:missionId/repair-payment-order`
- `POST /api/continuity/missions/:missionId/repair-payment-callback`
- `POST /api/continuity/missions/:missionId/repairs/:repairAttemptId/authorize`

Migration `0006_past_fat_cobra.sql` adds persisted market searches and snapshots, dynamic mission
specification/state, component selections, and an append-only outcome event ledger. External
offers become financial inputs only after normalization and persistence. For arbitrary internet
merchants, `AUTHORITY RESERVED` means MissionPay logical financial authority—not merchant inventory.

Required live configuration:

```text
MISSIONPAY_MARKET_MODE=live
SERPAPI_API_KEY=
MISSIONPAY_MARKET_FRESHNESS_SECONDS=180
MISSIONPAY_PLANNER_PROVIDER=groq
MISSIONPAY_PLANNER_MODEL=openai/gpt-oss-120b
GROQ_API_KEY=
MISSIONPAY_DEMO_MODE=true
```

Run `npm run db:migrate`, `npm run db:seed`, then `npm run dev`. Before Vercel deployment, apply
the migration to the configured Neon database and add the same server-only variables plus the
existing `DATABASE_URL` and Razorpay Test Mode credentials.

Migration `0007_wild_zombie.sql` adds separately linked continuity repair attempts, repair payment
orders, and repair payment attempts. A positive post-payment replacement delta is paid through a
new Razorpay Test Mode order; it never reopens or mutates the original captured order. Live
replacement discovery searches only the affected need, persists the new observations, preserves
unaffected selections, and then revalidates the resulting mission.
