# PayVolok

One API over many payment providers: payments, refunds, webhooks and status reconciliation in a single format, whatever each provider's rules are.

A *volok* (portage) is the place on the old Varangian route where boats were hauled overland from one river to the next. Payment providers are separate rivers too, with their own APIs, signatures and statuses. PayVolok carries a payment across and returns the result in one shape.

Pet project at an early stage. Sandbox only, no real money.

## Planned

- **API:** NestJS, TypeScript, Postgres, Drizzle.
- **Admin panel:** password protected; view everything and set up subscriptions.
- **Open test page:** try a sandbox checkout without logging in.
- **Providers:** Monobank first, then Paddle, then the rest one at a time.
