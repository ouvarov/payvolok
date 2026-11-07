# PayVolok

Planned as one API over many payment providers: payments, refunds, webhooks and status reconciliation in a single format, whatever each provider's rules are.

A _volok_ (portage) is the place on the old Varangian route where boats were hauled overland from one river to the next. Payment providers are separate rivers too, with their own APIs, signatures and statuses. PayVolok carries a payment across and returns the result in one shape.

Pet project at an early stage. Sandbox only, no real money: it only talks to provider sandboxes and never takes real payments.

## Status

What exists: the payment and refund ingest core, the fake provider, the health routes and the webhook route. `POST /webhooks/:provider` verifies the signature and stores the delivery in `webhook_events`; rows wait as `received` because nothing processes them yet. Everything else is planned, including the payment API, the worker, reconciliation and real providers.

## Stack

NestJS 12, TypeScript, Postgres 18, Drizzle ORM, zod for environment validation, Jest and supertest for tests. Node 24.9 or newer.

The repository root is the API. A web frontend will live in `web/` later.

## Planned

- **Admin panel:** password protected; view everything and set up subscriptions.
- **Open test page:** try a sandbox checkout without logging in.
- **Providers:** Monobank first, then Paddle, then the rest one at a time.

## Run locally

Copy `.env.example` to `.env` first. The app refuses to start when `DATABASE_URL` is missing or is not a Postgres URL.

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

## Health routes

- `GET /health/live` returns `200 {"status":"ok"}` while the process is up. It never touches the database.
- `GET /health/ready` returns `200 {"status":"ok"}` when `select 1` succeeds. If the database is unreachable or does not answer within two seconds it returns `503 {"status":"unavailable"}`, with no connection details.

## Fake provider

`fake` is a provider for development and chaos tests. It keeps no data. The last two digits of `amountMinor` choose the scenario: `01` fails, `02` succeeds after a failed attempt, `03` fails after a failed attempt, `04` expires, `05` stays pending, anything else succeeds. On a refund amount, `01` fails, `05` stays pending, anything else succeeds.

It signs webhooks with `FAKE_WEBHOOK_SECRET`, at least 32 characters, so several instances verify each other. When it is unset, each process makes a random secret at boot.
