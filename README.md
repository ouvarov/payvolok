# PayVolok

Planned as one API over many payment providers: payments, refunds, webhooks and status reconciliation in a single format, whatever each provider's rules are.

A _volok_ (portage) is the place on the old Varangian route where boats were hauled overland from one river to the next. Payment providers are separate rivers too, with their own APIs, signatures and statuses. PayVolok carries a payment across and returns the result in one shape.

Pet project at an early stage. Sandbox only, no real money: it only talks to provider sandboxes and never takes real payments.

## Status

What exists: the payment and refund ingest core, the fake provider, the health routes, the webhook route, the webhook worker, `POST /api/v1/payments`, `GET /api/v1/payments/:id` and `POST /api/v1/payments/:paymentId/refunds`. `POST /webhooks/:provider` verifies the signature and stores the delivery in `webhook_events`; the worker then applies it to payments and refunds. Everything else is planned, including reconciliation and real providers.

## Stack

NestJS 12, TypeScript, Postgres 18, Drizzle ORM, zod for environment validation, Jest and supertest for tests. Node 24.9 or newer.

The repository root is the API. A web frontend will live in `web/` later.

## Planned

- **Admin panel:** password protected; view everything and set up subscriptions.
- **Open test page:** try a sandbox checkout without logging in.
- **Providers:** Monobank first, then Paddle, then the rest one at a time.

## Run locally

Copy `.env.example` to `.env` first. The app refuses to start when `DATABASE_URL` is missing or is not a Postgres URL, when `API_KEY_SHA256` is missing or is not 64 lowercase hex characters, or when `PUBLIC_BASE_URL` is missing or is not an http or https URL. `PUBLIC_BASE_URL` is where providers reach this API: payments ask them to send webhooks to `{PUBLIC_BASE_URL}/webhooks/{provider}`.

### With Docker

```bash
docker compose up --build
```

This starts Postgres, applies migrations and then starts the API on <http://localhost:3000>. The credentials in `docker-compose.yml` are local development values only.

### Without Docker

```bash
npm ci
npm run db:local      # in-memory Postgres (PGlite) on port 55432, keep it running
```

In another terminal, set `DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres` and `DATABASE_POOL_MAX=1` in `.env` (PGlite serves one query at a time), then:

```bash
npm run db:migrate
npm run start:dev
```

Any other Postgres works too: point `DATABASE_URL` at it.

`npm run db:local` reads `LOCAL_POSTGRES_PORT` from `.env` (default 55432). For e2e against it, set `E2E_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres` and run `npm run test:e2e -- --runInBand`. With the Docker Postgres, create the e2e database first: `docker compose exec db createdb -U payvolok payvolok_e2e`.

The e2e tests apply migrations to `E2E_DATABASE_URL` once, before the Jest workers start, so a fresh database needs no `db:migrate`. PGlite still needs `--runInBand`. Lock, concurrency and statement timeout tests need a real Postgres and are skipped unless `E2E_REAL_POSTGRES=true`, which CI sets. Leave it unset on PGlite. Point `E2E_DATABASE_URL` at a direct connection, not a pooler.

## Scripts

| Script                                        | What it does                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                               | Compile to `dist/`                                                                                                                         |
| `npm run start:dev`                           | Run with file watching                                                                                                                     |
| `npm run start:prod`                          | Run the compiled build                                                                                                                     |
| `npm run lint` / `format:check` / `typecheck` | ESLint, Prettier check, `tsc --noEmit`                                                                                                     |
| `npm run check`                               | typecheck, lint and format check                                                                                                           |
| `npm test`                                    | Unit tests                                                                                                                                 |
| `npm run test:e2e`                            | End-to-end tests; read `E2E_DATABASE_URL` from `.env`, which must name an existing throwaway database other than the one in `DATABASE_URL` |
| `npm run db:generate`                         | Generate a Drizzle migration from the schema                                                                                               |
| `npm run db:migrate` / `db:migrate:prod`      | Apply migrations from sources / from the build                                                                                             |
| `npm run db:local`                            | In-memory Postgres for development and e2e                                                                                                 |

The role's 10 s `statement_timeout` also applies to migrations: a long statement in a migration needs `SET LOCAL statement_timeout = 0` before it.

Git hooks (simple-git-hooks): pre-commit runs lint-staged, pre-push runs `check` and the unit tests. CI runs the same checks plus e2e and a Docker boot.

## API access

Routes under `/api/v1` need `Authorization: Bearer <key>`. Every route declares its access with `@RouteAccess`; a route that declares nothing answers 401, even with a valid key. `/health/*` and `/webhooks/:provider` are public: webhooks are checked by their signature.

There is one key. The app only knows its SHA-256, so a stored hash cannot be used to call the API. Create a key and its hash with:

```bash
API_KEY=$(openssl rand -hex 32)
echo "$API_KEY"
printf %s "$API_KEY" | openssl dgst -sha256 -r | cut -d' ' -f1
```

Keep the key in your secret store and set the last line's output as `API_KEY_SHA256`. To rotate the key, change the hash and restart. `.env.example` and `docker-compose.yml` hold the hash of `local-dev-api-key`, for local development only.

Errors under `/api/` are JSON of one shape, with a stable `code`:

```json
{
  "statusCode": 401,
  "code": "unauthorized",
  "message": "Invalid or missing API key"
}
```

A 400 for an invalid body has `code: "validation_failed"` and `issues: [{ "field", "messages" }]`. Unknown fields are refused, not ignored.

### Create a payment

`POST /api/v1/payments` with an `Idempotency-Key` header and the body:

```json
{
  "provider": "fake",
  "amountMinor": 1000,
  "currency": "USD",
  "description": "Order 42",
  "returnUrl": "https://shop.example/return"
}
```

`amountMinor` is a positive integer in minor units, `currency` three uppercase letters, `description` 1 to 255 characters and `returnUrl` an http or https URL. On success it answers `201 {"paymentId": "...", "checkout": {"type": "redirect", "url": "..."}}`: send the customer to `checkout.url`. The payment is `pending` until the provider's webhooks move it on.

When the provider refuses the order the answer is `422 order_rejected`; when it cannot be reached, fails in an unexpected way or is set up wrong it is `503 provider_unavailable` with the `paymentId`. In both cases the payment is `failed` and the reason is in its events, unless a provider webhook already moved it on: then it keeps the provider's status and the failure is recorded as a `stale` event. Check `GET /api/v1/payments/:id` before retrying. Nothing retries on its own: retry with a new key.

### Refund a payment

`POST /api/v1/payments/:paymentId/refunds` with an `Idempotency-Key` header and the body `{"amountMinor": 500}`, in the payment's currency. On success it answers `201 {"refundId": "...", "paymentId": "...", "status": "pending"}`; `status` is `pending`, `succeeded` or `failed` as the provider reported it, and webhooks move it on.

Refused before the provider is called, storing nothing under the key:

- `404 payment_not_found` for an unknown payment.
- `409 payment_not_refundable` unless the payment is `succeeded` or `partially_refunded`.
- `422 refund_amount_exceeds_remaining` when the amount is larger than the payment minus its `pending` and `succeeded` refunds.
- `409 refund_in_progress` while another key's refund of the same payment waits for the provider.

When the provider refuses the refund the answer is `422 refund_rejected`; when it cannot be reached, is set up wrong or does not return a refund id it is `503 provider_unavailable` with the `paymentId`. A provider that identifies refunds by our id gets a `pending` refund row before the call; a refusal or a setup error marks it `failed`, an outage leaves it `pending`, because the refund may still have happened. A status a provider webhook already reported is kept. A provider that identifies refunds by its own id gets the row only after it answers.

A refund request interrupted after its key was taken stores `503 provider_unavailable` for that key after 60 s and changes no refund. Check the payment before retrying with a new key.

### Idempotency

`Idempotency-Key` is required on both POST routes: 1 to 255 printable ASCII characters without spaces, for example a UUID. A missing key is `400 idempotency_key_required`, a malformed one `400 idempotency_key_invalid`.

- The same key with the same body returns the stored answer, success or failure, with `Idempotent-Replayed: true`, and calls no provider again. The order of the JSON fields does not matter.
- The same key with another body is `422 idempotency_key_reused`.
- While the first request still runs, the same key gets `409 idempotency_key_in_progress`.
- A payment request that stopped after the payment row was written, for example a crash, holds its key for 60 s. The next request with that key then marks the payment `failed` (`request_interrupted`), or records that as `stale` if a webhook already moved it on, without calling the provider, and stores `503 provider_unavailable` for the key.
- Keys live 24 h. After that the same key starts a new payment or refund.
- Payment and refund keys are separate: one key string can be used once for each.

Only requests that reached the provider are stored: a 400 or 401 leaves no trace, so a fixed request can reuse its key.

`GET /api/v1/payments/:id` returns `paymentId`, `status`, `provider`, `amountMinor`, `currency`, `createdAt` and `updatedAt` from our database, or 404 `payment_not_found`. It does not call the provider.

## Health routes

- `GET /health/live` returns `200 {"status":"ok"}` while the process is up. It never touches the database.
- `GET /health/ready` returns `200 {"status":"ok"}` when `select 1` succeeds. If the database is unreachable or does not answer within two seconds it returns `503 {"status":"unavailable"}`, with no connection details.

## Webhook worker

Each API process runs a worker that takes `received` rows from `webhook_events` one at a time and applies their events to payments and refunds. A new delivery wakes it at once; otherwise it polls every `WEBHOOK_POLL_INTERVAL_MS` (default 5000, 100 to 3600000). Set `WEBHOOK_WORKER_ENABLED=false` (default `true`) for a process that should only serve the API.

Several processes can run workers on one database: a claim locks one row with `SKIP LOCKED` and leases it for 5 minutes, and a worker whose lease ran out cannot overwrite the row. A crash leaves the row due again after the lease; running it again is safe.

A row ends `processed` when at least one payment or refund event was applied, `ignored` when it held only unknown or subscription events, and `failed` when an event was rejected (an amount mismatch, an invalid value) or six attempts did not succeed. Retryable errors, such as an event that arrives before our payment row, wait 30 s, 2 min, 10 min, 1 h and 6 h between attempts. `last_error` keeps our own error message, or only the error class and Postgres code for anything else.

## Fake provider

`fake` is a provider for development and chaos tests. It keeps no data. The last two digits of `amountMinor` choose the scenario: `01` fails, `02` succeeds after a failed attempt, `03` fails after a failed attempt, `04` expires, `05` stays pending, anything else succeeds. On a refund amount, `01` fails, `05` stays pending, anything else succeeds.

Creating a payment fails at once for three endings: `97` is rejected (`422 order_rejected`), `98` is an outage and `99` a misconfiguration (both `503 provider_unavailable`). A refund amount with those endings fails the same way, with `422 refund_rejected` for `97`, once the amount is within the payment.

It signs webhooks with `FAKE_WEBHOOK_SECRET`, at least 32 characters, so several instances verify each other. When it is unset, each process makes a random secret at boot.

## License

[Apache-2.0](LICENSE)
