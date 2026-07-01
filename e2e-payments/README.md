# Payment sandbox e2e

Browser-driven, **real-money-shaped** end-to-end payment tests against the live
provider **sandboxes** (Stripe, Square, SumUp).

The main test suite (`deno task test`) exercises payments against `stripe-mock`
and stubbed Square/SumUp responses — fast, deterministic, and run on every PR.
This harness is the complement: it boots the **real** app server
(`src/index.ts`), exposes it through a public tunnel, and drives a **real
Chromium** through a complete paid booking, entering a sandbox test card on the
provider's own hosted checkout page and confirming the booking is recorded as
paid. It catches the one class of bug mocks cannot: our API calls, checkout
redirect, return URL, and webhook drifting from what the providers actually do.

It is intentionally **not** a PR gate (see `.github/workflows/payment-sandbox-e2e.yml`
— nightly + manual). It needs third-party network access and is slower and
flakier than mocked tests.

## What it does

For a target (`stripe` | `square` | `sumup` | `free`):

1. Builds the static client assets and boots `src/index.ts` against a throwaway
   local libsql file DB on a random port.
2. Starts a `cloudflared` quick tunnel so the app has a public HTTPS origin
   (required by Stripe to register its webhook; and because providers expect a
   public HTTPS return URL). `free` skips the tunnel.
3. Launches Chromium (Playwright) and, navigating as a human would:
   - runs first-run setup and logs in as admin;
   - selects and configures the payment provider from its secrets;
   - creates a priced listing and opens its public `/ticket/<slug>` page;
   - books, is redirected to the provider's hosted checkout, and pays with the
     provider's sandbox test card;
   - lands back on the app return URL and asserts the booking shows as paid
     (customer success page, the booker on the admin listing, **and** the
     captured amount in the listing's income ledger).

### What is (and isn't) exercised per provider

Confirmation is asserted via the **browser return URL** for every provider (the
success handler validates the session with the provider's API and records the
booking as paid — the harness then asserts the captured amount shows in the
listing's income ledger, not merely that an attendee row exists). No provider
leg *asserts* webhook delivery; webhook involvement differs only in what setup
each requires:

| Provider | Confirmation asserted | Webhook involvement |
| --- | --- | --- |
| Stripe | Return URL + captured amount | Endpoint **registration** is exercised (required to save the key); delivery is **not** asserted — the return handler records the payment, and a webhook may arrive before teardown but nothing waits on it. |
| SumUp | Return URL + captured amount | Needs no signature; a delivered webhook would be processed, but delivery is not asserted. |
| Square | Return URL + captured amount | None — Square requires a manually-signed subscription against a fixed URL, which can't be provisioned for an ephemeral tunnel. |

For Stripe, each run leaves a webhook endpoint pointing at that run's tunnel;
the harness deletes all `*.trycloudflare.com` webhook endpoints on teardown
(sweeping up any orphans too) so they don't accumulate in the sandbox account.

`free` runs the same journey with a £0 listing and no provider — a
secrets-free self-test of the harness and the app booking flow.

## Running locally

```bash
cd e2e-payments
npm install

# Harness self-test — no secrets, no tunnel, no money:
DENO_BIN=deno CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium \
  node --import tsx src/main.ts free

# A real provider sandbox (example: Stripe):
STRIPE_SECRET_KEY=sk_test_... \
DENO_BIN=deno CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium \
  node --import tsx src/main.ts stripe
```

Watch it happen in a real window with `HEADLESS=false`.

### Secrets / env

| Env var | Provider | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe | `sk_test_…` (test mode). |
| `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` | Square | Sandbox token + location. `SQUARE_SANDBOX=true` (default). |
| `SUMUP_API_KEY`, `SUMUP_MERCHANT_CODE` | SumUp | Sandbox secret key + matching merchant code. |

A target with missing secrets **skips** (exits 0) rather than failing.

Other knobs (all optional): `DENO_BIN`, `CLOUDFLARED_BIN`,
`CHROMIUM_EXECUTABLE` (unset in CI so Playwright uses its own build),
`HEADLESS`, `SETUP_COUNTRY` (site currency; defaults per provider — GB/GBP for
Stripe & SumUp, US/USD for Square), `E2E_UNIT_PRICE` (minor units, default 100),
`E2E_TUNNEL` (`1`/`0` to force), and the `E2E_*_TIMEOUT_MS` values in
`src/config.ts`. Screenshots and server logs land in `artifacts/` on failure.

## Two things to confirm on the first live run

Everything except the provider-owned pages and the tunnel is validated; these
two depend on live third-party behaviour and cannot be verified without
sandbox credentials + unrestricted egress:

1. **Hosted-checkout selectors.** `src/providers/*.ts` fill each provider's
   hosted checkout using the documented sandbox test cards and best-known field
   selectors, each with fallbacks. If a provider has changed its checkout DOM,
   the run fails with a screenshot in `artifacts/` — update the selector list in
   that provider's `payHostedCheckout`.
2. **Tunnel Host passthrough (Stripe only).** The app derives its public domain
   from the request `Host` header, and cloudflared quick tunnels forward the
   original `Host` — so `getEffectiveDomain()` resolves to the
   `*.trycloudflare.com` hostname and Stripe webhook registration gets a valid
   public URL. If a future cloudflared rewrites `Host` to `127.0.0.1`, Stripe
   webhook setup will reject it (Square/SumUp are unaffected — the browser
   follows the return URL on the same machine). The fix if that ever happens is
   to pin the origin Host header on the tunnel.

## Layout

```
src/
  main.ts            orchestrator + CLI entry (target from argv/E2E_PROVIDER)
  config.ts          env-driven config, secret resolution, skip logic
  server.ts          boot/teardown the real Deno app server on a file DB
  tunnel.ts          cloudflared quick tunnel (+ no-tunnel passthrough)
  browser.ts         Chromium lifecycle + form/navigation helpers
  flow.ts            setup → login → listing → book → confirm-paid journey
  providers/
    types.ts         PaymentProvider interface
    shared.ts        provider selection + "configured" assertion
    card.ts          resilient hosted-checkout field filling (frames + fallbacks)
    stripe.ts / square.ts / sumup.ts   per-provider config + hosted checkout
```
