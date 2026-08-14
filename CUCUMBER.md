# Live payment Cucumber harness

## Status and purpose

This is the approved implementation contract for converting the nightly payment
sandbox harness to Cucumber and extending it across the payment and refund
machinery built in PR4-A.

It is a handoff document, not a second source of production truth. The agent
implementing it must check every assertion against the current branch before
changing code. Once the work is built, the code, feature, and tests become the
authority. Update `e2e-payments/README.md` to describe the result and remove
this file in the final green commit so the plan cannot drift beside the built
system.

The work stays on `claude/m4-pr-a`. Do not create a fresh branch and do not
leave the old imperative journey runner operating beside Cucumber.

## Current-system value

If no later payment work ships, the nightly `Payment sandbox e2e` workflow will
prove against each real provider sandbox that:

1. a visitor's completed payment is recorded exactly once;
2. an owner refund either records exactly once or enters a visible state that
   cannot send again;
3. returned money survives a local Money-write failure and can be recovered;
4. a checkout made invalid while the visitor is paying is retained and refunded
   rather than silently disappearing; and
5. the complex order paths that worked before the conversion still work.

The production caller under test is the real `src/index.ts` application started
by `e2e-payments/src/server.ts` against a fresh file-backed libsql database. The
test uses the real public and admin routes, real Chromium, and the real Stripe,
Square, and SumUp sandbox endpoints.

There should normally be **no production `src/` change** in this slice. If
ordinary browser interaction exposes an actual production defect, do not hide it
with another forced action. Reproduce it with a regression test and return to
the human with the small plan amendment required to fix it.

## What is true before implementation

The latest inspected live run was GitHub Actions run `31771832492` on 14 August
2026. All four jobs genuinely executed and passed, but the run used `main` at
`470b47ef`. Scheduled GitHub workflows use the default branch, so that green run
is **not** evidence for `claude/m4-pr-a`.

The existing harness already provides useful evidence:

| Target | Genuine external work                                                                                                    | Current shortcut or omission                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stripe | Hosted Checkout, test card, signed webhook, browser return, provider read, real refund, webhook registration and cleanup | The first exact return is held while the webhook wins and is not subsequently replayed                                                                       |
| Square | Real sandbox order, payment and refund APIs, followed by the real application return route                               | Square's sandbox has no browser-drivable buyer card page; completing the payment through its Payments API is unavoidable, and no Square webhook is exercised |
| SumUp  | Hosted checkout, test card, provider read, browser return, genuine checkout-id callback processing and replay            | The callback is delivered by the harness rather than awaited from SumUp, and no SumUp refund is exercised                                                    |
| Free   | Real browser, setup, public booking and admin verification                                                               | No provider is involved                                                                                                                                      |

Stripe and Square's existing admin refund journey already travels through the
new PR4-A path: exact processed-payment reference, provider evidence read,
`payment_charges` authority, claimed send, real provider refund, Money ledger
recording, authority recording, and claim settlement. SumUp's keyless refund
path is the major live-provider omission.

The current harness is not yet an honest visitor-level test in two ways:

- `e2e-payments/src/browser.ts` force-fills and force-clicks controls and calls
  `form.submit()`, bypassing actionability, submit handlers, and native browser
  validation.
- one logged-in browser page is reused for owner and public booking work. A
  genuine visitor should use a separate browser context without owner cookies.

Cucumber alone fixes neither problem. The conversion must fix both while
retaining the unavoidable Square sandbox exception.

## Scope

Build one complete vertical harness slice:

- Cucumber becomes the single journey/orchestration layer.
- Existing server, tunnel, browser, order, and provider mechanics are reused and
  refactored behind a shared typed contract.
- The old `runJourneys` orchestration and optional `afterPaidBooking` extension
  point are deleted.
- Every nightly provider job must execute. Missing paid-provider credentials are
  a failure, not a successful skip.
- The feature gains the exact six scenarios/templates below. Square and SumUp
  are separate so SumUp's unsigned-callback refusals remain visible rather than
  hiding behind provider-specific step branching.
- The workflow emits Cucumber reports and a concise, truthful provider outcome
  summary.
- The public-tunnel and cleanup issues named below are fixed in the same harness
  change.

Do not add:

- legacy payment support;
- old untagged-provider recovery;
- a DB-encryption-key threat model;
- production migrations or schema changes;
- a second payment test runner;
- a production-only or `E2E` fault switch;
- blanket job, scenario, checkout, or refund retries;
- a state-machine framework;
- a forwarding proxy for synthetic lost provider responses;
- every mocked provider error arm in the live nightly suite; or
- a live manager-permission matrix. The deterministic Cucumber suite already
  owns role permissions and artificial provider outcomes.

## The executable feature

Create `e2e-payments/specs/live-payment-providers.feature`. It must be readable
as the human contract, not as a sequence of selectors or implementation calls.

The repository's feature profile only accepts `story`, `owner`, `risk`, `actor`,
`edition`, `rule`, `case`, and `surface` metadata. Do **not** invent
`@provider`, `@nightly`, `@live`, or `@irreversible-sandbox` tags. Target
selection will use the case ids.

Every Feature and Rule needs a description. Every Scenario belongs to a Rule.
Every ordinary Scenario needs `@case:<id>`. Every Scenario Outline Examples
table needs a `case_id` column, and every other column must be used as a
placeholder. The following is the intended feature shape; wording may improve,
but its behaviours and case ids are the contract:

```gherkin
@story:payments.live-sandbox-contract
@owner:payments
@risk:high
@actor:customer
@actor:organiser
@edition:self-hosted
Feature: Real sandbox payments finish safely
  The nightly harness uses the real application, a visitor browser and each
  provider sandbox. A green case means the visible booking and Money records
  agree with the exact provider resource, including after a replay or an
  interrupted local write.

  @rule:payments.live-free-booking-records-once @surface:admin @surface:public
  Rule: A free booking is recorded once
    The no-provider journey proves that setup, the public form and the admin
    assertions work before a third-party provider is involved.

    @case:live-payments.free-booking-once
    Scenario: A visitor makes a free booking
      Given the owner has published a free listing
      When a separate visitor books the listing
      Then the visitor sees the booking confirmation
      And the owner sees one attendee and no payment income

  @rule:payments.live-stripe-refund-survives-local-failure @surface:admin @surface:public @surface:return @surface:webhook
  Rule: A returned Stripe payment survives a local Money failure
    Stripe may have returned real money before the local refund ledger can be
    written. The booking remains protected, a stale form cannot return the
    money twice, and Refresh completes the local record when Money recovers.

    @case:live-payments.stripe-refund-recovers
    Scenario: Stripe returns money while Money temporarily refuses the refund
      Given Stripe is configured with dedicated test credentials
      And the owner has published a priced listing
      When a separate visitor pays through Stripe Checkout
      And Stripe's signed webhook confirms the payment
      And the visitor retries the exact browser return
      Then the owner sees one attendee and the captured income once
      When the owner opens the same refund form in two windows
      And Money temporarily refuses to record refund transfers
      And the owner submits the first refund form
      Then Stripe shows the full amount returned
      And the owner is warned not to refund again
      And Refund and Delete are unavailable while Refresh remains reachable
      When the owner submits the stale second refund form
      Then Stripe still shows only the original returned amount
      And Money still has no refund entry
      When Money accepts refund transfers again
      And the owner refreshes the payment
      Then Money shows exactly one refund
      And the booking says the payment was refunded
      And Refund is unavailable while Delete is reachable

  @rule:payments.live-square-refund-is-safe @surface:admin @surface:public @surface:return
  Rule: A Square refund reaches a safe durable result
    Square must apply the exact payment once and must never expose another send
    after its refund call may have landed.

    @case:live-payments.square-refund-safe
    Scenario: A Square payment is replayed and refunded safely
      Given Square is configured with dedicated sandbox credentials
      And the owner has published a priced listing
      When the Square sandbox completes a separate visitor's payment
      And the visitor retries the exact payment return
      Then the owner sees one attendee and the captured income once
      When the owner refreshes the exact payment
      And the owner submits its rendered refund form once
      Then the refund is either recorded or visibly waiting for observation
      And no second Refund action is available
      And destructive actions are unavailable while observation is unfinished
      And Refresh is reachable while observation is unfinished
      When the owner refreshes the payment without submitting Refund again
      Then the provider's returned amount and Money refund count do not grow

  @rule:payments.live-sumup-refund-is-safe @surface:admin @surface:public @surface:return @surface:webhook
  Rule: A SumUp callback and refund reach a safe durable result
    SumUp's genuine checkout callback is replayable, untrusted callback bodies
    are refused before a provider read, and its keyless refund cannot expose a
    second send while observation is unfinished.

    @case:live-payments.sumup-refund-safe
    Scenario: A SumUp payment is replayed and refunded safely
      Given SumUp is configured with dedicated sandbox credentials
      And the owner has published a priced listing
      When a separate visitor pays through SumUp's hosted checkout
      And the genuine checkout callback is delivered twice
      Then the owner sees one attendee and the captured income once
      When forged, oversized, empty and missing callback ids are delivered
      Then each receives the same fixed retryable refusal
      And the refused callbacks cause no additional SumUp read
      When the owner refreshes the exact payment
      And the owner submits its rendered refund form once
      Then the refund is either recorded or visibly waiting for observation
      And no second Refund action is available
      And destructive actions are unavailable while observation is unfinished
      And Refresh is reachable while observation is unfinished
      When the owner refreshes the payment without submitting Refund again
      Then the provider's returned amount and Money refund count do not grow

  @rule:payments.live-invalidated-checkout-is-refunded @surface:admin @surface:public @surface:return @surface:webhook
  Rule: A checkout invalidated while the visitor pays is retained and refunded
    A listing can change after checkout begins. A later successful charge must
    not disappear merely because the booking can no longer be fulfilled.

    @case:live-payments.stripe-invalidated-checkout-refunded
    Scenario: The owner changes the price while a visitor is paying
      Given Stripe is configured with dedicated test credentials
      And a separate visitor has begun paying for a priced listing
      When the owner changes the listing price in another browser
      And the visitor completes Stripe Checkout
      And Stripe's signed webhook processes the payment
      Then the visitor is told their details were saved and payment refunded
      And the owner sees one retained No quantity booking
      And Stripe shows the exact captured amount returned
      And Money shows the payment and one refund netting to zero
      And Money shows no sale for the unfulfilled booking
      And the retained booking shows the system reason
      When the visitor retries the exact return
      Then there is still one retained booking and one refund
      And Stripe still shows only the original returned amount

  @rule:payments.live-complex-order-keeps-every-path @surface:admin @surface:public
  Rule: A complex order records every booking path
    The conversion must preserve the existing package, independent member and
    ordinary listing journey, including the exact per-listing income.

    Scenario Outline: A visitor completes a complex order using <provider>
      Given the owner has published a package, its members and a plain listing
      When a separate visitor submits them together using <provider>
      Then every requested booking path appears once
      And each listing shows its exact expected income

      Examples:
        | provider | case_id |
        | Free     | live-payments.complex-free |

      @surface:return
      Examples:
        | provider | case_id |
        | Stripe   | live-payments.complex-stripe |
        | Square   | live-payments.complex-square |
        | SumUp    | live-payments.complex-sumup |
```

The Square step must remain honest: its sandbox cannot provide a hosted buyer
card UI, so the provider driver completes the exact sandbox payment through the
Square Payments API before the visitor browser follows the real application
return URL. The feature description or report must disclose that exception.

The SumUp callback step must also remain honest. It uses the genuine checkout id
created by the hosted payment, but the harness self-delivers the callback and
does not claim to prove SumUp's eventual webhook delivery.

The invalidated-checkout Scenario proves the expected late price-drift path. It
does not claim that every arbitrary exception thrown while booking can be
converted into a refund or shown to the visitor.

## Trusted and observed facts

Keep expected facts and provider observations separate in types and step state.

### Expected facts

- The staged application checkout contains the expected listing, amount,
  currency, and return binding.
- Each scenario creates a unique run identity and unique listing and booker
  values. Those values select only this scenario's resources.
- The saved success URL is the exact URL produced by that checkout. It is not
  reconstructed from a later account search.
- Owner forms are rendered by the real application with the real authenticated
  session and CSRF state.
- The fault scenario's database URL belongs to its fresh ephemeral application
  server.

### Observed facts

- The exact provider checkout/payment reports the id, account or location,
  amount, currency, and status actually observed.
- The exact provider resource reports the amount returned and whether the refund
  is complete or still pending.
- Stripe's verified webhook signature proves who sent that event; it does not
  replace the later provider observation.
- The owner-facing attendee, Actions, recovery, and Money pages report the local
  durable result.
- A provider response missing a documented field is invalid and fails at the E2E
  provider boundary. It must never become zero, empty, unpaid, or an empty
  refund history.

Never query "the latest payment/refund in the account." Every provider read and
cleanup operation must use the exact ids captured for the current scenario.

## Valid test-visible states

Use a discriminated union for the result observed after a refund. Do not encode
these variants as optional fields or broad text fallbacks.

| State                          | Required facts                                                                                                 | Visible contract                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `payment_recorded`             | Exact provider identity, captured amount and currency, saved return identity                                   | One attendee and the captured income once                                                                 |
| `refund_recorded`              | Exact provider identity, returned amount equal to captured amount, one local refund                            | Refund unavailable; no unfinished-work blocker; rendered Delete opens the enabled confirmation form       |
| `refund_observing`             | Exact provider identity, evidence that a send may have landed, observation time and next eligible observation  | Refund and destructive actions unavailable; Refresh or recovery reachable; never represented as completed |
| `refund_returned_local_due`    | Provider shows the full amount returned, local Money write absent, durable unrecorded work                     | Warning not to refund again; Refund/Delete unavailable; Refresh reachable                                 |
| `invalidated_booking_refunded` | One retained quantity-zero booking, exact provider return, payment/refund cash round-trip, no sale, and reason | Replay preserves the same retained booking and refund                                                     |
| `failed`                       | Boundary and phase identifying the failure                                                                     | Non-zero run; diagnostic artifacts; no automatic replay after an irreversible call                        |

An unavailable read before any refund send is a failed nightly contract: the
provider functionality was not proven. An unavailable or pending read after a
send may have landed can satisfy only `refund_observing`, and only when all
blocking and recovery controls are correct.

A clean sandbox reaching `needs_owner_choice`, malformed evidence, the wrong
amount/currency/account/parent, partial return, excess return, or multiple
pending refunds fails. Those are valid production safety states, but they are
not the expected result of this live happy sandbox resource.

## Commands and events

| Starting state               | Command or event                            | Required result                                                                                                     |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No application               | Scenario starts                             | Static assets built once; fresh app DB, server, tunnel when needed, owner context and visitor context               |
| Fresh application            | Owner completes setup and configures target | Exact sandbox provider active; configuration visibly accepted                                                       |
| Published listing            | Visitor submits booking                     | Exact hosted checkout or free confirmation                                                                          |
| Checkout open                | Provider completes payment                  | `payment_recorded` or a loud failure                                                                                |
| Payment recorded             | Exact return/callback is replayed           | Same attendee, income, and processed payment; no duplicate booking                                                  |
| Refundable payment           | Owner submits rendered refund form          | `refund_recorded`, `refund_observing`, or `refund_returned_local_due`; never a second command hidden behind a retry |
| Refund observing             | Owner uses the visible Refresh control      | Observation only; before eligibility it may perform no provider read, but it never sends a refund                   |
| Returned/local due           | Money fault is removed and owner refreshes  | One local refund, recorded authority, work retired                                                                  |
| Stripe checkout open         | Owner changes listing price                 | Checkout remains payable but its later booking admission fails                                                      |
| Invalidated checkout charged | Signed webhook processes it                 | Retained booking plus exact automatic refund                                                                        |
| Any terminal state           | Exact callback/return/refresh is replayed   | Same terminal state and no additional money movement                                                                |

The Cucumber target selector is the only command dispatcher for nightly cases.
Do not keep a separate `if target then run these imperative journeys` path.

## Failure contract

| Work completed              | Failure                                                 | Required result                                                                                                               | Retry owner                                                                      |
| --------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Nothing external            | Static build, app boot, tunnel or browser startup fails | Fail as infrastructure; release acquired resources                                                                            | A later workflow run; tunnel startup alone may use its existing bounded attempts |
| Provider not configured     | Required secret missing or sandbox connection refused   | Fail before checkout; never report skipped or executed                                                                        | Repository owner fixes credentials                                               |
| Checkout may have completed | Browser navigation, callback, or follow-up read fails   | Preserve exact identity and fail; do not start a new checkout automatically                                                   | Human investigates artifact or exact provider resource                           |
| Refund may have landed      | Browser response or provider reread fails               | No automatic Refund replay; require visible observation protection or fail                                                    | Production Refresh/recovery observes the exact resource                          |
| Provider returned money     | Local refund-ledger write fails                         | Durable `refund_returned_local_due`; warning and blockers visible                                                             | Owner uses Refresh after local recovery                                          |
| Scenario passed             | Provider/browser/tunnel/server cleanup fails            | Run fails and records cleanup error                                                                                           | Next run or account janitor                                                      |
| Scenario already failed     | Cleanup also fails                                      | Preserve primary scenario error and attach cleanup error; attempt all remaining cleanup                                       | Human investigates both                                                          |
| Any phase                   | Artifact or notification write fails                    | Do not replace a more important scenario failure; fail an otherwise-green run when required artifact/report integrity is lost | Workflow owner                                                                   |

Do not use empty `catch`, catch-and-continue, or best-effort cleanup. Gather
cleanup results, run every cleanup action, and report an aggregate without
hiding the original scenario error.

## Retry and replay contract

| Operation                  | Stable identity                                                                      | Exact replay                                                                                                                             | What prevents duplicate work                                   |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Booking completion         | Saved provider checkout/session/order id and exact success URL                       | Same visible booking                                                                                                                     | Production processed-payment reservation and replay binding    |
| Stripe webhook plus return | Same Stripe Checkout Session and PaymentIntent                                       | One attendee and income result                                                                                                           | Signed webhook processing plus processed-payment identity      |
| SumUp callback             | Exact staged checkout id                                                             | Genuine callback twice gives one result; forged, oversized, empty and missing ids receive the same fixed refusal without a provider read | Callback replay binding and staged-id prefilter                |
| Owner refund               | Durable payment reference, exact attendee row generation, canonical charge authority | Observe or finish the same authority; never create another money movement                                                                | Claim, send authority and provider idempotency where supported |
| Stripe stale second form   | Same form state and attendee generation                                              | No extra returned amount or local refund                                                                                                 | Revision/claim/authority checks and Stripe idempotency         |
| Refresh                    | Canonical authority and exact provider resource                                      | Observation or local completion only                                                                                                     | Refresh has no send capability                                 |

Rules:

- Cucumber `retry` stays `0`.
- The workflow does not automatically rerun a failed paid scenario.
- All refund transports retain zero network retries. Do not add scenario-level
  retries; preserve existing checkout transport behaviour outside this change.
- Tunnel startup may retain its bounded retry because it happens before any
  irreversible payment work.
- Poll by explicit state and deadline, never by arbitrary fixed sleeps.
- For a pending refund, never press Refund again. One immediate Refresh may
  prove the control is observation-only, but the nightly job does not wait five
  minutes or bypass `next_observation_at` to force an eligible provider read.
- A pending Scenario may pass only as `refund_observing`, and the job summary
  must say that completion was not seen.

## Concurrency contract

| Overlap                                           | Required result                                                 | Protection/evidence                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stripe signed webhook and browser return          | One recorded payment                                            | Hold the first browser return, let the webhook win, then replay the exact return                                                    |
| Owner edits price while visitor has checkout open | One retained failed booking and one automatic refund            | Separate owner and visitor contexts; signed checkout facts versus current listing state                                             |
| Two owner windows hold the same refund form       | First call may return money; stale second form cannot move more | Two independently authenticated owner contexts render before either submits; durable claim/authority and exact provider observation |
| Provider jobs run together                        | No shared app state or wrong resource selection                 | Separate GitHub runners, fresh DBs, unique run ids, exact provider ids                                                              |
| Scenarios within one provider job                 | No fixed DB directory or provider resource race                 | Cucumber parallelism fixed to `1`; fresh server and DB per scenario                                                                 |

Do not add a live simultaneous-send stress test. The deterministic
`specs/payments/refunding-from-two-windows.feature` suite owns exact concurrent
interleavings without risking repeated sandbox money movements.

## Owner choices

None are expected in these clean sandbox journeys.

If the application presents a real owner choice, the nightly case fails and
captures the evidence. The harness must never answer a money conflict, mark a
review complete, or treat a generic acknowledgement as a successful refund.

## Security and privacy boundaries

- Only repository-controlled Actions jobs and developers holding dedicated
  sandbox credentials may run paid targets.
- Stripe must continue to reject any key not beginning `sk_test_`.
- Square must always use the sandbox API base. Remove the harness's production
  mode knob rather than trusting `SQUARE_SANDBOX=false` never to be supplied.
- SumUp keys have no reliable mode prefix. The workflow must use a dedicated
  test merchant/account, and the limitation must be explicit in documentation.
- Generate a unique owner username and strong password per run before exposing
  the application through a public tunnel. Do not retain the repository-known
  `admin`/`password` defaults for tunneled runs.
- Generate a unique, provider-acceptable booker email, name, listing names, and
  run id. Do not use shared "latest resource" queries.
- Pass only the selected provider's credentials into each matrix job. The free
  job receives no payment-provider credential.
- Do not log secret headers, tokens, card data, or raw provider responses.
- Provider ids and the synthetic booker identity may appear in restricted
  Actions diagnostics, but settings pages and secrets must not be attached.
- Set a short artifact retention period, recommended seven days.
- Keep workflow permissions at `contents: read`.

This work deliberately does not investigate an attacker holding
`DB_ENCRYPTION_KEY`, legacy PII storage, or populated-database migrations.

## Shared implementation contract

### One Cucumber runner

Reuse `runSpecs` from `scripts/specs/run.ts`; do not invoke a second copy of the
Cucumber CLI or recreate reporting logic. Call it with a custom environment:

```typescript
const environment = {
  reportDir: join(repoRoot, "e2e-payments", "artifacts", "cucumber"),
  support: [
    "e2e-payments/src/cucumber/support/**/*.ts",
    "e2e-payments/src/cucumber/steps/**/*.ts",
  ],
};

const summary = await runSpecs(
  {
    paths: ["e2e-payments/specs/live-payment-providers.feature"],
    tags: casesFor(target),
  },
  environment,
  { parallel: 1 },
);
```

The actual code must use named helpers and explicit return types rather than
copying this sketch blindly.

`runSpecs` already supplies:

- metadata validation;
- defined order;
- strict mode;
- zero retries;
- progress output;
- Cucumber message, HTML, and JUnit reports; and
- report-directory preparation.

The exact formatter files are `cucumber.ndjson`, `cucumber.html`, and
`cucumber.junit.xml`, with progress written to stdout.

Put its report directory under `e2e-payments/artifacts/cucumber`, not the root
`reports` directory, so the existing workflow artifact upload captures it and
report cleanup does not delete screenshots or server logs.

Before calling `runSpecs`, `main.ts` must clean the whole
`e2e-payments/artifacts` directory and build static assets once. Do not clean
the artifact root in `BeforeAll`: Cucumber has opened its formatter outputs by
then, and the hook could delete the live report files. `runSpecs` itself safely
prepares only the nested Cucumber report directory.

The E2E member currently resolves some root workspace imports, but its
configuration should remain self-contained for this runner. Mirror the exact
root-pinned imports needed by `scripts/specs/run.ts` and its catalog/profile
dependencies in `e2e-payments/deno.json`:

- `@cucumber/cucumber`;
- `@cucumber/cucumber/api`;
- `@cucumber/gherkin`;
- `@cucumber/messages`; and
- `@cucumber/tag-expressions`; and
- `valibot`.

Keep `playwright` explicitly pinned in the member configuration: the workflow
parses that exact entry to install the matching Chromium build.

Add `@libsql/client` only if the scoped ledger fault uses a direct libsql
connection. Keep the same pin as the root workspace.

### Exhaustive target-to-case selection

The command remains:

```bash
nix develop -c deno task e2e free
nix develop -c deno task e2e stripe
nix develop -c deno task e2e square
nix develop -c deno task e2e sumup
```

`main.ts` becomes a thin boundary that parses the target, validates required
configuration, maps it to case ids, invokes `runSpecs`, publishes the result,
notifies on failure, and sets the exit status.

Use an exhaustive `Record<Target, readonly LiveCaseId[]>`. The intended map is:

| Target   | Cases                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `free`   | `live-payments.free-booking-once`, `live-payments.complex-free`                                                              |
| `stripe` | `live-payments.stripe-refund-recovers`, `live-payments.stripe-invalidated-checkout-refunded`, `live-payments.complex-stripe` |
| `square` | `live-payments.square-refund-safe`, `live-payments.complex-square`                                                           |
| `sumup`  | `live-payments.sumup-refund-safe`, `live-payments.complex-sumup`                                                             |

Turn those ids into an `@case:... or @case:...` expression. This uses the
repository's existing metadata selection. It does not by itself make omissions
safe: `runSpecs` deliberately returns a successful zero-case run when a tag
expression matches nothing.

Use `beforeRun` to inspect the catalog and assert that every id in the full
target record exists exactly once. Use `onSuccess` to count Cucumber
`testCaseFinished` messages and require exactly the number of cases selected for
this target. A renamed or deleted Examples row must fail rather than produce a
green provider job that did no work. Put the catalog/expected-count handshake in
a pure helper with direct tests under `test/e2e-payments/`.

This Feature lives outside the normal root `specs/` tree. The ordinary
`specs:check`, focused-spec routing, and mutation selection do not discover it.
Its live invocation still validates it through `readSpecCatalog`; the direct
catalog/selection tests under root `test/` make that handshake part of normal
CI. Do not place ordinary `.test.ts` files only under `e2e-payments`, where the
root test runner will not discover them.

Ordinary Cucumber's default step timeout is five seconds, far below the current
45-90 second browser/provider allowances. E2E support must call
`setDefaultTimeout` with a bounded E2E step timeout. Give startup and teardown
hooks their own explicit bounded timeouts, and give only the genuinely long
hosted-payment step a narrowly larger timeout where necessary. Do not solve this
by setting one enormous global timeout, and do not enable retries.

Delete `RunResult = "executed" | "skipped"`. A successful invocation publishes
`result=executed`; missing paid credentials throw before a browser or provider
call. The workflow must never describe missing provider coverage as green.

### Scenario world and resource lifetime

Static assets are built once before `runSpecs`. Every Scenario gets:

1. a fresh file-backed app database;
2. a new real `src/index.ts` child process;
3. a new tunnel for paid providers, or the local URL for free;
4. one browser process or shared per-scenario browser harness;
5. a separate authenticated owner browser context;
6. a separate cookie-free visitor browser context;
7. a second independently authenticated owner context when a stale form is part
   of the Scenario;
8. a unique run identity; and
9. a typed provider runtime holding only this scenario's ids and owned
   resources.

Hooks own infrastructure acquisition and disposal. Setup, sign-in, provider
configuration, listing creation, booking, and refund actions belong in visible
Given/When steps rather than disappearing into hooks.

Teardown belongs in `After` and always attempts, in order appropriate to avoid
leaks:

- removal of any installed database fault;
- capture of case-id-scoped failure screenshot, HTML, phase journal and useful
  server log;
- browser contexts/browser;
- provider-owned temporary resources;
- tunnel; and
- application server.

The exact order can change where needed to preserve diagnostics, but every
resource must be attempted. If the Scenario has already failed, attach cleanup
errors without obscuring the Scenario error. If it passed, cleanup errors make
it fail.

Use the case id in every artifact filename so two or three Scenarios in one
target job cannot overwrite each other's `refund-failed.png` or HTML. Save the
complete PNG, page HTML, journal, and server log as workflow artifacts. Attach
only a bounded screenshot and useful server-log tail to Cucumber; do not embed
huge HTML or unbounded logs in the message report.

The existing target-level ntfy notification remains. `runSpecs` returns
`{ success: false }` for ordinary step failures rather than throwing, so
`main.ts` must explicitly turn that result into a failed command and notify. It
must not publish `result=executed` for a failed Cucumber result.

`e2e-payments/.tmp` is a fixed path, so Cucumber parallelism must remain `1`
inside a target job. GitHub matrix jobs have separate filesystems and may remain
parallel.

Do not make World fields a collection of optional values whose meaning depends
on which steps happened. Use a small state union or named `require...` boundary
methods that fail with the missing phase and scenario identity.

### Browser contract

Refactor browser ownership so an application browser can open one or many
independent sessions through the same mechanism. A single session is an array of
one conceptually; do not keep a separate one-page implementation.

For application controls:

- locate by accessible role, label, name, or user-visible text;
- use ordinary `fill`, `check`, `selectOption`, and `click` without `force`;
- submit through the visible submit control or `requestSubmit`, preserving
  browser validation and application event handlers;
- wait for the observable navigation or page state caused by the action;
- click ordinary application links rather than reading `href` and navigating
  around actionability; and
- use direct `goto` only when direct navigation is itself the tested behaviour,
  such as replaying a saved return URL.

The stale refund race does not navigate to a copied URL: a URL cannot preserve
POST fields or CSRF state. Both independently signed-in owner contexts must
render and hold their own refund confirmation forms before the first one
submits. The second then submits its still-rendered form through the normal
browser control.

Provider-owned hosted pages may keep narrowly justified selector fallbacks.
Square's API completion is the documented exception, not a generic escape hatch.

The existing browser comment says normal submission encountered an invalid
rendered `pattern`. If that is still reproducible for a real visitor, it is a
production bug. Do not preserve `form.submit()` to conceal it. Stop, add the
exact regression test, and amend this plan before changing `src/`.

### Provider contract

Replace the optional `afterPaidBooking` shape with one explicit shared contract
implemented by every paid target. Different provider facts belong in an
exhaustive discriminated union, not optional fields that silently omit a
journey.

The minimum facts the shared journey needs are:

```typescript
type PaidSandboxCheckout =
  | {
    provider: "stripe";
    returnUrl: string;
    checkoutSessionId: string;
    paymentIntentId: string;
  }
  | {
    provider: "square";
    returnUrl: string;
    orderId: string;
    paymentId: string;
  }
  | {
    provider: "sumup";
    returnUrl: string;
    checkoutId: string;
    transactionId: string;
  };

type SandboxRefundObservation =
  | {
    kind: "completed";
    returnedAmount: number;
    currency: string;
  }
  | {
    kind: "pending";
    observedAt: string;
  };
```

Names and exact fields may adjust to the provider APIs, but these invariants may
not:

- checkout completion returns the exact identity and saved return URL;
- provider observation is read-only and scoped to that identity;
- completed observations carry actual amount and currency;
- a missing expected field throws at the raw provider boundary;
- provider-specific mechanics stay inside the provider driver;
- shared steps consume only the exhaustive shared result; and
- there is no fallback to the site's currently configured provider.

`PayHostedCheckout` currently returns `void`; change it to return this exact
identity. Stripe's one-use held-return route must capture the complete
intercepted `/payment/success?session_id=...` URL before the page leaves it.
Wait through the owner UI until the signed webhook has reached its terminal
local result, then replay that saved URL; otherwise the supposed replay could
win the original reservation race. Apply the same webhook-first discipline to
the price-invalidation Scenario.

Square already holds its order and payment ids inside `completeViaSandboxApi`;
return them instead of discarding them. SumUp must stop re-scanning the last
matching log line after checkout and carry the exact checkout and transaction
ids for this Scenario. Fresh-DB log scanning may be used at the narrow creation
boundary if the app exposes no better value, but the resulting id must
immediately become typed Scenario state.

Do not reuse the production parser as the only assertion of the production
parser. The harness should independently validate the small provider facts it
needs from raw sandbox responses. It need not recreate every production schema.

### Stripe webhook ownership and cleanup

The current Stripe cleanup deletes every endpoint whose host ends in
`trycloudflare.com`. Replace that broad sweep.

The Scenario owns the exact URL `${scenario.publicBaseUrl}/payment/webhook`.
List endpoints with proper pagination and delete all and only exact URL matches.
This also cleans an endpoint left by configuration that failed before an id
could be recorded. Never use an account-wide before/after set difference:
another legitimate consumer could create an endpoint between those reads and be
mistaken for this Scenario's resource. Stripe's configuration assertion must
still prove that saving the key twice rotates the endpoint and leaves exactly
one current exact URL.

Payments, refunds, and orders are append-only sandbox resources and are not
pretended to be cleanable. Unique run identities keep them attributable.

### Scoped Money fault

The Stripe failure Scenario may alter only its fresh ephemeral DB. Expose its
`dbUrl` on `AppServer`; the parent process does not otherwise inherit the child
server's `DB_URL`. Open a separate libsql client against that exact URL, install
and remove the fault, then close the client. The ordinary deterministic helper
cannot be reused unchanged because it writes through the test process's
singleton database connection.

Install a persistent SQLite `BEFORE INSERT` trigger on `transfers` using the
already-proven condition from `test/specs/support/refund-safety/faults.ts`:
`WHEN substr(NEW.kind, 1, 7) = 'refund_'`. This catches every refund leg,
including fee or modifier legs, and raises an error. A temporary trigger is
connection-local and would not affect the app server's connection, so do not use
one. Give the trigger an E2E-specific name.

The helper contract is:

```typescript
interface InstalledFault {
  remove(): Promise<void>;
}

declare function refuseRefundTransfers(
  server: AppServer,
): Promise<InstalledFault>;
```

`remove` uses `DROP TRIGGER IF EXISTS`, is idempotent, closes the libsql client,
and must run from the Scenario's `After` hook even if a step fails. Installing
the trigger before the payment ledger is recorded would invalidate the Scenario,
so install it only after the paid booking and its income assertions are
complete.

Do not inspect or mutate PR4-A authority rows to manufacture the desired state.
Only the real provider response plus a realistic Money write failure should
produce it.

The first failed local recording redirects to `/admin/privacy#refund-recovery`,
not back to the attendee. Assert the warning there, then navigate through
rendered controls to the protected attendee and Actions pages to prove
Refund/Delete are unavailable and Refresh is reachable. After recovery, prove
Delete reachability by clicking the rendered Delete action and finding an
enabled Delete Attendee confirmation form; inspecting an `href` alone does not
prove the template and route compose.

The live Stripe read can honestly prove one provider refund resource and one
returned amount for the exact PaymentIntent. It cannot prove only one physical
HTTP request reached Stripe merely from the final amount—idempotent duplicate
requests could converge to one resource. Deterministic Cucumber owns exact call
count; do not overstate the live assertion.

### Pending refund observation

The current shared refund helper requires immediate `Refund issued`. That is too
narrow: an accepted Stripe/Square refund or SumUp's delayed transaction history
is not a failed send.

After the single rendered Refund submission, classify the actual UI and exact
provider observation into `refund_recorded` or `refund_observing`. Assert the
whole state, not one convenient substring:

- `refund_recorded`: full provider amount returned, exactly one Money refund,
  Refunded visible, Refund absent, no unfinished blocker, and the rendered
  Delete action opens an enabled Delete Attendee confirmation form;
- `refund_observing`: never claim Refunded, Refund absent, Delete/merge absent,
  clear pending copy, and reachable Refresh/recovery.

Do not add a five-minute wait for SumUp's production observation eligibility to
the nightly job. For an immediately visible observing state, one immediate
Refresh may prove that Refresh is observation-only and does not change the
provider's returned amount. It must not send, and it need not force a provider
read before the production due time. Finish with the truthful safe state and
`pendingObserved: true` in the summary. Deterministic Cucumber proves the later
eligible observation and retirement.

The completed and observing branches must each execute their own assertions; do
not implement the later Refresh step as a silent no-op for one variant. Record
the branch and which observation action actually ran in the result journal and
job summary.

Deterministic Cucumber remains the authority for forcing every precise
`accepted -> observing -> completed`, unavailable, uncertain, rejected,
not-sent, and owner-choice transition.

### Diagnostics and result journal

Maintain a small non-secret phase journal per Scenario under artifacts. It
should contain:

- run id and Cucumber case id;
- provider and scenario phase;
- exact non-secret sandbox resource ids;
- whether checkout or refund may have happened;
- final local state;
- final provider observation; and
- whether pending was genuinely observed.

This is diagnostic evidence, not resumable test state. A failed workflow must
not automatically consume the journal to repeat an irreversible action.

Write a concise `$GITHUB_STEP_SUMMARY` table with case, provider, executed
status, completed/pending outcome, and artifact name. A green workflow must not
claim that pending was tested on a run where every provider completed
immediately.

## Workflow changes

Update `.github/workflows/payment-sandbox-e2e.yml`:

1. Keep nightly and manual triggers.
2. Keep `permissions: contents: read` and serialized workflow concurrency.
3. Keep the four matrix targets and `fail-fast: false`.
4. Remove `must_execute`; every row must report `executed`.
5. Pass only the selected provider's secrets. Conditional expressions may set
   unrelated provider variables to an empty value, but the child environment
   must not receive another provider's usable credential. Use verified
   target-specific conditional run steps or an indexed-secret expression; do not
   retain the current shared environment block.
6. Keep `SQUARE_SANDBOX` fixed to true or remove the switch entirely from the
   harness.
7. Pin `cloudflared` to an exact release and verify its published checksum
   before executing it. Do not download `releases/latest` in a secret-bearing
   job. Select and record the reviewed release and digest during implementation;
   do not invent an unverified value from this plan.
8. Upload `e2e-payments/artifacts`, including Cucumber HTML, JUnit, message
   output, screenshots, journals, and server log, with seven-day retention.
9. Keep artifacts on failure and success.
10. Verify the harness result is exactly `executed`; `skipped` is no longer a
    valid result.

The scheduled workflow still runs only the default branch. Pre-merge evidence
therefore comes from an explicit manual dispatch with `--ref claude/m4-pr-a`.

Keep the actual tested country defaults accurate when rewriting the README:
Stripe uses US, while Square and SumUp use GB on this harness. The current
README states Stripe/Square the other way around.

## Provider and database call budgets

The budgets below concern only calls made by the application's refund workflow.
They exclude provider configuration/connection checks, checkout creation and
confirmation, callbacks, cleanup, and the harness's independent verification
reads.

| Journey                 | Normal app calls | App hard maximum | Notes                                                                                             |
| ----------------------- | ---------------: | ---------------: | ------------------------------------------------------------------------------------------------- |
| Stripe owner refund     |                3 |                4 | pre-refund Refresh read, readiness read, send; one bounded reread only after an inconclusive send |
| Square owner refund     |                3 |                4 | same shape as Stripe                                                                              |
| SumUp owner refund      |                4 |                4 | Refresh read, readiness read, send, and mandatory fresh transaction read                          |
| Stripe automatic refund |                2 |                3 | checkout-session confirmation read, send, and one bounded reread only when inconclusive           |

Each deliberately eligible later production observation would add one
application provider read; this nightly scope does not wait five minutes to
force one. The immediate post-result Refresh must not resend. A live browser
cannot honestly prove that a completed Refresh made zero provider reads without
interception, so its assertion is stable UI, returned amount, and Money count.
The deterministic direct/Cucumber suite remains the zero-provider-call
authority.

The harness may make one direct read-only provider verification after an
irreversible action and, for the stale-form assertion, one additional read. It
must never send through the provider driver. Count and report those verification
reads separately from application calls.

Fresh Scenario isolation means Stripe setup, connection testing, and webhook
rotation run three times in its job, while Square and SumUp configure twice.
That materially increases setup calls and runtime compared with the current
one-server-per-target runner. Keep those calls outside the refund budget but
include them in the job summary/runtime expectation; do not share a database or
provider configuration across Scenarios merely to make the numbers look smaller.

Database budget:

- no production schema or migration;
- one fresh database per Scenario;
- ordinary application writes caused by the visitor/owner journey;
- Stripe failure case only: one scoped trigger create and one trigger drop;
- no whole-table attendee or confirmation scan; and
- no direct mutation of payment authority, attendee PII, processed payment, or
  refund rows.

## Expected files and line budget

Names may be shortened to fit the final shape, but group the Cucumber files and
keep each code/test file below 400 lines.

Expected additions:

- `e2e-payments/specs/live-payment-providers.feature`;
- `e2e-payments/src/cucumber/support/world.ts`;
- `e2e-payments/src/cucumber/support/hooks.ts`;
- focused step files under `e2e-payments/src/cucumber/steps/`;
- a small refund-observation helper;
- a small scoped database-fault helper; and
- direct tests under `test/e2e-payments/` for pure target selection, outcome
  classification, strict provider observations, and cleanup/error aggregation.

Expected changes:

- `e2e-payments/src/main.ts` becomes the thin target/Cucumber boundary;
- `e2e-payments/src/browser.ts` supports honest one-or-many browser sessions;
- `e2e-payments/src/config.ts` requires paid target secrets and generates
  per-run identities;
- `e2e-payments/src/server.ts` exposes the exact ephemeral DB address;
- `e2e-payments/src/flow.ts` accepts the Scenario identity rather than shared
  global booker values;
- `e2e-payments/src/order-flow.ts` is called by steps rather than `main.ts`;
- provider types and drivers return exact typed checkout/observation facts;
- Stripe cleanup owns only Scenario-created endpoints;
- SumUp composes callback replay and real refund evidence;
- `e2e-payments/deno.json` gains the pinned runner imports;
- `e2e-payments/README.md` is rewritten to match the delivered feature and Nix
  commands; and
- `.github/workflows/payment-sandbox-e2e.yml` runs and reports the contract.

Expected deletions:

- `runJourneys` and journey sequencing from `main.ts`;
- `PaymentProvider.afterPaidBooking?`;
- successful missing-secret skips;
- broad Stripe `trycloudflare.com` endpoint sweeping;
- forced application form actions and direct form submission; and
- stale README claims such as Square not refunding or local commands using
  `mise`.

Budget:

- production `src/`: 0 expected;
- production database changes: 0;
- net harness/spec/test growth: at most roughly 450 lines after deleting the old
  orchestration;
- total touched lines: expected 700-1,100 because orchestration and browser
  ownership move into Cucumber support; and
- no file over 400 lines.

If the net shape grows substantially beyond this, stop. It likely means the
steps are recreating provider/application implementations or that the old runner
has not really been removed.

## Test-first implementation order

### 1. Capture the branch baseline

Before editing the harness, manually dispatch the current workflow against the
branch:

```bash
gh workflow run payment-sandbox-e2e.yml --ref claude/m4-pr-a
gh run list --workflow payment-sandbox-e2e.yml \
  --branch claude/m4-pr-a --limit 1
gh run watch <run-id> --exit-status
gh run view <run-id> --log
```

Record the run id and verify from logs that free, Stripe, Square, and SumUp all
say `RESULT: executed`. A green workflow with a skipped optional leg is not a
complete baseline.

This baseline spends sandbox operations. Run it once, not after every local
edit.

### 2. Pin the feature and runner contract

- Add the Feature first.
- Add direct tests for target parsing, exhaustive case selection, required
  secrets, refund-outcome classification, and cleanup error precedence.
- Confirm the focused tests or free Cucumber invocation fail for missing runner
  and steps for the expected reason.
- Connect `runSpecs` with the custom support/report environment and parallel 1.

### 3. Make the free case green

- Build the World and hooks.
- Split owner and visitor browser contexts.
- Replace forced application controls with normal visitor actions.
- Run only `live-payments.free-booking-once`, then `complex-free`.
- If normal submission exposes a real application bug, stop and amend the plan
  rather than bypassing it.

### 4. Build the hardest invariant first

Implement `live-payments.stripe-refund-recovers` before the ordinary provider
refund outline:

- exact webhook/return replay;
- two stale owner pages;
- scoped transfer trigger;
- real provider return observation;
- durable unrecorded UI and blockers;
- no second money movement; and
- Refresh retirement.

Use direct tests for the trigger helper and result classifier. Do not repeatedly
run the paid live case while its behaviour is moving; use existing deterministic
Cucumber and focused direct tests for fast feedback.

### 5. Add SumUp and Square shared refund conformance

- Express the two valid live outcomes through the shared union.
- Add SumUp's real keyless refund.
- Preserve the complete current SumUp callback contract as explicit steps:
  genuine callback twice; forged UUID, oversized, empty, and missing ids; the
  same fixed 503 response; four refusal log lines; and no additional SumUp read
  log lines.
- Prove Refresh causes no additional returned amount or Money entry. Leave the
  exact zero-provider-call assertion to deterministic tests.
- Prove pending observation disables send/destruction and keeps recovery
  reachable.

### 6. Add the Stripe invalidated-checkout case

- Save the exact checkout return identity.
- Change the listing price in the owner context while the visitor remains on
  Stripe Checkout.
- Hold the browser return, wait through the owner UI for the signed webhook to
  terminalize, and only then replay the exact return.
- Let the genuine signed callback drive the production automatic-refund path.
- Do not call `assertPaidBookingConfirmed`: the correct quantity-zero result has
  no sale leg, no income, and `price_paid = 0`. Assert customer saved/refunded
  copy, one No quantity admin row, payment plus refund netting to zero, no sale,
  reason note, exact provider return, and replay convergence.

### 7. Preserve the complex order matrix

Move the existing `runComplexOrderJourney` assertions behind the feature steps
for all four targets. Do not weaken its package/member/plain-listing or exact
income assertions during the move.

### 8. Harden workflow and cleanup

- Require all targets.
- Restrict secrets per job.
- Randomize identities and credentials.
- Pin `cloudflared` and verify checksum.
- Replace broad Stripe cleanup.
- Aggregate cleanup failures.
- Add Cucumber reports, result journal, summary, and artifact retention.
- Rewrite the E2E README from the delivered behaviour.

### 9. Final verification

Use Nix for every Deno command.

Fast checks while implementing:

```bash
nix develop -c deno task test:files test/e2e-payments/<focused-file>.test.ts
nix develop -c deno task e2e free
nix develop -c deno check --config=e2e-payments/deno.json e2e-payments/src
```

Run formatting and the narrow feature/target after stable changes. Do not use
live paid providers as the inner development loop.

Once the candidate is stable:

```bash
nix develop -c deno task precommit
nix develop -c deno task precommit:mutation
```

There is no separate mutation-testing campaign for the live harness, but the
repository's final mutation gate remains mandatory. Commit all relevant changes
before `precommit:mutation`, because it tests the committed branch diff.

Then manually dispatch the upgraded workflow against `claude/m4-pr-a` once.
Require all four legs to report `executed`; inspect the Cucumber HTML/JUnit
results, server diagnostics, provider outcome summary, and cleanup result.

## Existing deterministic authority

Do not move the following exhaustive behaviours into live provider sandboxes:

- `specs/payments/recovering-the-money-record.feature` owns provider success
  followed by deterministic Money failure and recovery variants;
- `specs/payments/refunding-from-two-windows.feature` owns controlled concurrent
  requests and delete/merge blocking;
- `specs/payments/resolving-uncertain-refunds.feature` owns forced SumUp
  observing, not-sent, returned, owner-choice, and recovery transitions; and
- `specs/payments/only-owners-refund.feature` owns owner/manager permissions and
  forbidden copied links/forms.

The nightly Feature complements those tests by validating the real external
protocol and one carefully scoped end-to-end recovery seam. It does not replace
deterministic fault coverage or direct source-line coverage.

## Adversarial review decisions

The following questions are resolved and must not be rediscovered during
implementation:

- **Does Cucumber itself add confidence?** No. It adds a readable executable
  contract and standard reports. Confidence comes from the real server, separate
  visitor context, ordinary browser actions, exact provider resources, and
  stronger scenarios.
- **Should Playwright or provider drivers be rewritten?** No. They remain the
  mechanics beneath Cucumber and are refactored only where the contract needs
  better boundaries.
- **Should a live pending refund fail?** Not when the application proves the
  safe observing state. It passes truthfully as pending and is reported as such;
  it never passes as completed.
- **Should the harness wait five minutes for SumUp?** No. It may use one
  immediate visible Refresh to prove no resend, then reports the safe state
  actually seen. Deterministic tests own the later eligible observation.
- **Should a paid Scenario retry after failure?** No. A payment or refund may
  already have happened.
- **Should Square pretend to be a visitor card journey?** No. The API completion
  exception is explicit because the sandbox lacks the UI.
- **Should SumUp pretend its callback was delivered by SumUp?** No. The harness
  says it self-delivers the genuine checkout id.
- **Should every provider outcome be forced live?** No. Shared sandbox account
  manipulation is order-dependent and flaky. Deterministic Cucumber owns those
  states.
- **Should the live suite inject a lost HTTP response proxy?** No. That is a
  separate optional manual/weekly slice if ever justified.
- **Should cleanup remain best-effort?** No. A leak fails a green journey and is
  attached to an already-failed one.
- **Should Square or SumUp be optional because secrets can expire?** No. Missing
  coverage is a failed nightly contract and must be visible.
- **Should the test inspect historical or legacy payments?** No. Every Scenario
  creates a new tagged payment using the current application path.
- **Should Cucumber share one logged-in page for speed?** No. Owner and visitor
  have separate contexts; the price race depends on that being real.
- **Should application forms keep `force`/`form.submit()` for CI stability?**
  No. A control a normal browser cannot operate is a real failure.
- **Should the Stripe fault mutate payment authority directly?** No. Only a
  scoped failure at the Money write boundary is allowed.
- **Should completed Refresh call the provider to make the assertion stronger?**
  No. The live browser proves stable UI and money totals. Existing deterministic
  tests prove the internal zero-call short circuit; adding interception here
  would widen the live harness into proxy instrumentation.

## Completion checklist

The implementation is complete only when all are true:

- [ ] A pre-change manual branch run is recorded and all four targets executed.
- [ ] The new Feature validates against the repository metadata profile.
- [ ] `main.ts` is a thin Cucumber boundary and the old orchestration is gone.
- [ ] No successful `skipped` paid result remains.
- [ ] Owner and visitor use separate browser contexts.
- [ ] Application controls use ordinary browser interaction without force or
      direct `form.submit()`.
- [ ] Stripe's genuine webhook wins and the exact return is replayed.
- [ ] Square's API-completion limitation is explicit.
- [ ] SumUp's self-delivered genuine callback limitation is explicit.
- [ ] Stripe local-ledger failure leaves visible durable recovery work.
- [ ] A stale second refund form moves no additional provider money.
- [ ] Refresh records exactly one local refund and retires completed work.
- [ ] SumUp performs a real keyless sandbox refund.
- [ ] Completed and observing outcomes are exhaustive and reported truthfully.
- [ ] Stripe price drift retains the failed booking and automatically refunds
      once.
- [ ] Exact return/callback replay duplicates neither booking nor money.
- [ ] The complex order matrix retains every old assertion for all targets.
- [ ] All provider lookups and cleanup use exact Scenario-owned ids.
- [ ] Stripe cleanup no longer sweeps unrelated quick-tunnel endpoints.
- [ ] Cleanup failures are never swallowed.
- [ ] All paid targets are mandatory nightly jobs with target-only secrets.
- [ ] `cloudflared` is pinned and checksum-verified.
- [ ] Cucumber message, HTML, and JUnit reports are uploaded for seven days.
- [ ] The job summary distinguishes completed from genuinely pending outcomes.
- [ ] Focused direct tests, free Cucumber, typecheck, precommit, and mutation
      gates pass.
- [ ] The final manual branch workflow has four executed green jobs.
- [ ] `e2e-payments/README.md` describes the actual delivered behaviour and uses
      Nix commands.
- [ ] No parallel compatibility runner or dead helper remains.
- [ ] `CUCUMBER.md` is removed after the code and tests become authoritative.
