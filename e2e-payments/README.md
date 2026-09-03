# Payment sandbox e2e

Browser-driven, **real-money-shaped** end-to-end payment tests against the live
provider **sandboxes** (Stripe, Square, SumUp), orchestrated by Cucumber.

The main test suite (`deno task test`) exercises payments against `stripe-mock`
and stubbed Square/SumUp responses — fast, deterministic, and run on every PR.
This harness is the complement: it boots the **real** app server
(`src/index.ts`), exposes it through a public tunnel, and drives a **real
Chromium** through a complete paid booking, entering a sandbox test card on the
provider's own hosted checkout page and confirming the booking is recorded as
paid. It catches the one class of bug mocks cannot: our API calls, checkout
redirect, return URL, refund, and webhook drifting from what the providers
actually do.

It is intentionally **not** a PR gate (see
`.github/workflows/payment-sandbox-e2e.yml` — nightly + manual). It needs
third-party network access and is slower and flakier than mocked tests.

## Running

```bash
# From the repo root (builds static assets, boots the app):
nix develop -c deno task e2e free

# A real provider sandbox (example: Stripe):
STRIPE_SECRET_KEY=sk_test_... nix develop -c deno task e2e stripe
```

Watch it happen in a real window with `HEADLESS=false`.

A missing paid secret **fails** instead of skipping — the nightly contract
requires every provider.

## What it does

For a target (`free` | `stripe` | `square` | `sumup`), `main.ts` parses the
target, validates its secrets (throwing before any browser call if missing),
maps it to its exhaustive case selection, cleans the artifact root, builds
static assets once, then hands everything to the repository's shared Cucumber
runner (`runSpecs`). Each scenario in the Feature file gets:

1. a fresh file-backed app database;
2. a new real `src/index.ts` child process;
3. a new tunnel for paid providers (or the local URL for free);
4. one browser process with separate authenticated owner and cookie-free visitor
   browser contexts (a second owner context for the stale-form race);
5. a unique run identity (booker email, listing names, owner credentials — never
   the defaults); and
6. a typed provider runtime holding only this scenario's exact ids.

Hooks own infrastructure acquisition and disposal. Setup, sign-in, provider
configuration, listing creation, booking, and refund actions belong in visible
Given/When steps rather than disappearing into hooks.

### The Feature

`e2e-payments/specs/live-payment-providers.feature` is the human contract: each
Rule names one safe-durable result, and every step states a visible outcome.

The seven scenarios:

- **free-booking-once** — the no-provider journey proves setup, the public form
  and the admin assertions work before a third-party provider is involved.
- **stripe-refund-recovers** — Stripe returns money while the local Money write
  fails; the booking stays protected, a stale form cannot double-refund, and
  Refresh completes the local record when Money recovers.
- **square-refund-safe** — a Square payment is replayed and refunded; the refund
  is either recorded or safely observing, with no second Refund.
- **sumup-refund-safe** — a SumUp payment is replayed (genuine self-delivered
  callback); forged ids receive the one fixed refusal without a read; the
  keyless refund reaches a safe result.
- **sumup-return-pending** — the visitor opens the payment return before paying;
  the waiting page says the payment is not confirmed yet and keeps checking, no
  error is logged, and the same return books once the payment is confirmed.
- **stripe-invalidated-checkout-refunded** — the owner changes the price while a
  visitor is paying; the webhook processes the later charge, retains the booking
  at quantity 0, and automatically refunds.
- **complex-order-<provider>** — a package, member, and plain listing booked in
  one order, with per-listing income verified.

Square's sandbox has no hosted buyer card page, so its driver completes the
payment through the Payments API before the browser follows the real app return
URL. SumUp's callback is self-delivered by the harness with the genuine checkout
id — the harness does not claim to prove SumUp's own webhook delivery.

### Browser interaction

The app is driven the way a person drives it: fill fields by their accessible
name, click buttons and links by their visible text, and submit through the
visible submit control (`requestSubmit`) — never force, never `form.submit()`.
Some headless Chromium builds stop scheduling compositor frames after a form
POST, which stalls Playwright's stability wait; the harness detects that and
falls back to `requestSubmit` / a scripted click, which still runs browser
validation and the app's own event handlers. A failed ordinary action is only
replayed through that fallback when a page-side witness proves the click never
dispatched — a post-dispatch failure rethrows, so a live refund form can never
be submitted twice by the fallback.

### Cleanup

Teardown runs every cleanup action (fault removal, browser, provider resources,
tunnel, server), collecting failures. A cleanup failure on a passing scenario
fails it, and on a failed scenario is reported alongside the original error
without obscuring it.

### Notes per provider

| Provider | Country  | Webhook                                                                              | Refund                                                    |
| -------- | -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Stripe   | US (USD) | Signed webhook registration, rotation, and cleanup of only this scenario's exact URL | Real refund; Money fault scenario with persistent trigger |
| Square   | GB (GBP) | None (return-URL only; Square has no browser card page)                              | Real sandbox refund API                                   |
| SumUp    | GB (GBP) | Unsigned, self-delivered genuine callback; forged ids refused unread                 | Real keyless refund; delayed history may report pending   |

Secrets / env: see `src/config.ts` for all knobs (all optional except
`DB_URL`/`DB_ENCRYPTION_KEY` which the runner sets). Set provider secrets as
environment variables before running the corresponding target.

## Layout

```
src/
  main.ts              thin target boundary → runSpecs
  entry.ts             the failure boundary both sandbox harnesses share
  targets.ts           exhaustive target→case selection + catalog handshake
  config.ts            env-driven config, required secrets, identity generation
  server.ts            boot/teardown the real Deno app server on a file DB
  tunnel.ts            cloudflared quick tunnel (+ no-tunnel passthrough)
  browser.ts           Chromium lifecycle + honest form/navigation helpers
  cleanup.ts           attemptEveryCleanup + cleanup error precedence
  db-fault.ts          scoped Money-transfer refusal (persistent trigger)
  refund-outcome.ts    classify submitted refund: recorded or observing
  flow.ts              shared journey helpers (setup, login, listing, booking)
  order-flow.ts         the complex-order journey (catalog build + verification)
  providers/
    types.ts           PaidSandboxCheckout / SandboxRefundObservation / driver
    shared.ts          providerFetch, requiredField, observeViaRead, factories
    stripe.ts          Stripe: pay, refund observation, exact-URL endpoint cleanup
    square.ts          Square: sandbox API completion, payment read
    sumup.ts           SumUp: hosted card fill, checkout/transaction ids
    sumup-callback.ts  callback contract (genuine twice + refusal probes)
    card.ts            resilient hosted-checkout field filling
  cucumber/
    support/world.ts   LiveWorld: scenario identity + phases + boundary methods
    support/hooks.ts   Before (infra) + AfterStep (flag) + After (teardown)
    support/journal.ts per-scenario non-secret phase journal
    steps/setup.ts     Given steps: provider config, listing publication
    steps/booking.ts   When/Then: visitor pays, return replay, admin assertions
    steps/refund.ts    When/Then: refund flows, Money fault, recovery
    steps/pages.ts     shared page-navigation and page-fact gathering helpers
```
