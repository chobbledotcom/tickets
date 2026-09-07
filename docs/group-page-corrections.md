# Group page and package privacy corrections

Status: approved by the owner on 7 September 2026, with the three decisions
below recorded. Implementation proceeds slice by slice, regression tests first.

PR: [#2259](https://github.com/chobbledotcom/tickets/pull/2259). Reviewed
revision: `48c929b435eb5d5c6cf2301bf943c4404c3948b4`. Comparison base:
`1bdfa698d6ac928047d20c12f5a377d1a91b53e7`.

## Current-system value

Ticket pages use their selected roots for visibility. Package returns preserve
concealment. Public prices and date checks use the same capabilities as
checkout. Admin pages advertise only destinations that exist.

## Scope

| Review finding                  | Required outcome                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mixed-cart robots policy        | Package roots and explicit standalone roots determine the policy. Expanded members do not.           |
| Balance success redirect        | Balance payments show paid success with no external thank-you redirect, whatever the original paths. |
| Cancellation fallback           | A concealed or unresolved package does not authorise a member retry link.                            |
| Child-span minimum price        | Incompatible child alternatives cannot lower the advertised minimum.                                 |
| Date-filter request budget      | One capacity snapshot serves all daily cards and package members.                                    |
| Concealed API membership probes | Expected client refusals do not identify member or child relationships.                              |
| Inactive admin share controls   | Inactive listings have no public URL, embed, or QR action that leads to an unavailable page.         |
| QR POST test migration          | The signed-price POST test requires exactly one checkout call.                                       |

The public balance recap also discards package provenance and displays member
names. This proposal includes its correction because it exposes the same order
before the balance return.

No new payment lifecycle, stored schema, migration, or provider integration is
required. Existing package membership restrictions remain unchanged.

## Trusted facts

| Fact                                  | Authority and use                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| URL slugs and form values             | Untrusted until the existing route and form resolvers accept them.                |
| Resolved listing and group roots      | Their stored `hidden` fields determine robots policy.                             |
| `hide_package_listings`               | Current package presentation policy, separate from root visibility.               |
| Signed purchase items and allocations | Expected purchase paths after existing ownership validation.                      |
| Synthetic balance item                | Expected balance amount and target reference, not proof of a standalone purchase. |
| Successful processor result           | Resolved attendee identity after settlement or replay.                            |
| Persisted real booking rows           | Observed listing and package paths for balance and token responses.               |
| Package display records               | Current permission to disclose names. Missing records grant no permission.        |
| Child capability fields               | Configured duration and price support. An absent day price does not mean free.    |
| Capacity snapshot                     | Advisory availability for one request, not reserved stock.                        |
| Session role and read-only state      | Existing authentication and destination guards remain authoritative.              |

## Valid states

These corrections add no durable states. The existing payment machines remain
the authority for charges, settlement, refunds, and replay.

### Page roots

A ticket page has a non-empty set of resolved roots. Each root supplies its own
visibility. The page is hidden if any surviving root is hidden.

A group page has one group root. A mixed cart has package roots and explicit
standalone roots. A member selected beside its package remains an independent
root. Dropped roots do not affect the result.

`TicketSharedContext.pageHidden` remains the single output fact. An explicit
root collection replaces inference from expanded member listings. Every caller
migrates together, without an old-signature adapter.

### Booking returns

Purchase returns use signed real purchase paths. Token returns use persisted
real booking rows. Quantity-zero rows grant no disclosure permission.

For purchases and token returns, one actual listing with a genuine standalone or
named-package path permits its configured thank-you URL. Several actual listings
produce no arbitrary first-listing redirect. Missing listings produce no URL.
Tagged concealed rows remain concealed even beside a named row for the same
listing. A named path for one listing does not authorise another listing.

**Balance returns are different, by owner decision:** a balance payment never
shows an external thank-you URL, even when its original booking had a genuine
named path. The buyer sees the ordinary paid success page. The synthetic
checkout item never authorises a redirect, and this suppression does not depend
on reading the attendee's booking rows.

### Standalone destinations

The shared eligibility decision distinguishes available, inactive, and
non-standalone-child listings. An active hidden listing remains eligible for
direct access. An active closed or full listing also remains eligible because
its ticket page serves a refusal or sold-out state.

The same decision governs overview links, embed controls, QR tabs, QR creation,
QR refresh, and public QR generation. Role permissions remain separate.

## Commands and outcomes

| Command or state                                      | Required result                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET or POST a mixed ticket page                       | Use the surviving root collection for robots policy.                                         |
| Calculate, QR, API, admin, or renewal route           | Preserve its existing non-indexable endpoint policy.                                         |
| Balance settlement succeeds                           | Paid success with no external thank-you redirect. Do not undo or repeat the settlement.      |
| Cancel a live package                                 | Retry through that package if its package page still serves.                                 |
| Cancel an unavailable concealed or unresolved package | Use the existing home action unless a genuine named alternative permits a live listing link. |
| Cancel an unavailable named package                   | Preserve the existing live member fallback.                                                  |
| Cancel a balance checkout                             | Use the home action. Do not interpret the synthetic item as a purchase-again selection.      |
| GET a public balance recap                            | Conceal tagged package rows without changing ledger totals or raw admin data.                |
| Read a package price for a duration                   | Exclude generally unavailable and span-incompatible children before the minimum calculation. |
| Invalid concealed package API request                 | Apply the approved generic client-refusal policy below.                                      |
| GET date-filtered listings                            | Read one widest-span capacity snapshot, then derive each listing's own span result.          |
| Inactive listing QR request                           | Refuse before token or SVG creation.                                                         |
| Signed-price QR POST test                             | Require the correct price, redirect, and exactly one provider checkout call.                 |

## Shared mechanisms

### Payment and display paths

Extend the grouped booking reader only where a caller genuinely needs it; the
balance suppression removes the balance success read this contract once planned.
Keep listing IDs, quantities, and package IDs associated until disclosure is
decided. Do not add package tags to synthetic balance metadata.

Reuse `hasNamedBookingPath` for the disclosure rule. Batch cancellation group
reads and reuse the existing group availability mechanism. A referenced group
must still be a package before it qualifies as a package retry.

Add package provenance to the existing order-summary read. Keep its raw lines
and accounting totals available to admin callers. Derive a public recap through
the existing package-row grouping mechanism, generalised only where necessary.

Do not create a fresh balance capability from cancellation metadata. The current
cancellation path does not establish the price-proof authority needed for that.

### Child prices

Put shared span eligibility beside `dayCountsChildSupports` in the booking
model. Both the fold and the advertised minimum use that declaration. Do not
create an import cycle between the price module and the fold.

Standard parents supply one day. Fixed daily parents supply their fixed span.
Customisable parents supply the chosen span. Explicit free prices remain valid.
Pay-more children contribute their configured minimum. Member overrides do not
override child prices.

The price remains a span-compatible minimum, not an exact reservation of stock
or an optimiser for every date and shared-capacity arrangement.

### Date availability

Deduplicate the union of daily listing cards and package members. Read one
`loadCapacitySnapshot` for the widest required span. Use `remainingFromSnapshot`
with each listing's own span.

Reuse holidays from the existing listing load. Customisable listing cards keep
their current one-day availability rule. Package cards retain their current
advisory availability semantics. No per-package or per-span query loop remains.

## Failure table

| Boundary                                 | Required result                                                | Retry owner                                              |
| ---------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Invalid public input                     | Existing refusal, subject to the concealed API response policy | Caller after correction                                  |
| Missing package display                  | No inferred member disclosure                                  | A later request reevaluates current facts                |
| Missing listing                          | No listing URL or public recap row                             | No automatic repair                                      |
| No real rows after successful settlement | Paid success without a listing redirect                        | No settlement replay needed                              |
| Display read fails after settlement      | Propagate the read failure without another charge or refund    | Browser reload through existing session or ledger replay |
| Capacity read fails                      | Fail the request, not fabricated availability                  | Request infrastructure or caller                         |
| QR target becomes inactive               | Refuse at generation or scan according to observed state       | Operator after reactivation                              |
| Forbidden role or read-only form         | Preserve existing guard response                               | Authorised operator                                      |
| Provider or ledger failure               | Preserve existing payment recovery and refusal semantics       | Existing payment machinery                               |

No blanket catch converts database, decryption, or invariant failures into a
successful response or an ordinary invalid-choice message.

## Retry and replay

These corrections add no idempotency keys or workers. Existing payment session
and ledger identities remain authoritative. Exact payment replay does not repeat
settlement or refund. Invalid API replay creates no reservation or checkout, but
it can consume the existing rate-limit allowance.

Repeated valid API POST requests retain their existing behaviour. This change
does not promise new booking idempotency.

## Concurrency

| Overlap                         | Required result                                                  | Protection                                     |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Two balance payments            | Existing expected-amount and settlement rules decide the outcome | Existing atomic ledger and finalisation guards |
| Webhook and browser return      | One financial result                                             | Existing session claim and replay machinery    |
| Display read and deletion       | Missing facts grant no disclosure                                | Bounded current reads and destination guards   |
| Page capacity read and purchase | The page can become stale                                        | Existing atomic submission guards              |
| QR generation and deactivation  | A later scan still refuses an inactive listing                   | Both boundaries enforce eligibility            |
| Visibility edit and page render | One request uses its resolved root and display facts             | Existing request scope and cache invalidation  |

No display transaction can revoke HTML already sent or reserve a future link
destination. This contract does not claim that guarantee.

## Approved decisions

Recorded 7 September 2026 against the plan presented to the owner.

1. **Balance returns — suppress all thank-you URLs.** A balance payment shows
   the ordinary paid success page with no external redirect, even when the
   original booking had a genuine named path. Balance cancellation uses the
   plain home action. Accepted trade-off: a balance payer whose booking was
   fully named also loses their configured redirect.
2. **Public balance recap — one package row, summed quantity.** Collapse each
   concealed package's member rows into one row with the package name and the
   summed booked quantity, the same convention tickets and emails use. Use a
   generic `Package` label when its display record is absent. Admin summary
   keeps raw rows and accounting totals.
3. **Concealed API refusals — both 400 and 409 become one generic 400.** Any
   failed client refusal on a loaded concealed package returns
   `This package cannot be booked with those choices.`, so a stock refusal
   cannot distinguish a valid relationship from a wrong one. Successful
   responses, root 404s, rate-limit 429s, and server errors are unchanged. Named
   packages keep their specific responses. This hides failed-request
   distinctions, not all possible successful guesses or timing differences.

These decisions do not authorise new package membership combinations or changes
to financial outcomes. Existing restrictions on concealed packages and child
selectors remain in force.

## Module and test map

This map names existing entry points and proposed responsibilities. After each
slice, update it to the actual exported names and any approved differences.

| Responsibility             | Current source locations                                                                                                                   | Direct regression locations                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return-path disclosure     | `src/features/api/payment-success.ts`, `src/features/api/payment-processing/cancel.ts`, `src/shared/db/attendees/tokens.ts`                | `test/features/api/payment-success/`, `test/features/api/payment-processing/cancel.test.ts`, `test/integration/server/balance-payment-replay.test.ts` |
| Public balance recap       | `src/shared/db/attendees/balance.ts`, `src/features/public/balance.ts`, `src/ui/templates/public/balance.tsx`, shared package-row grouping | `test/shared/db/attendees/balance.test.ts`, `test/features/public/balance/get.test.ts`, `test/features/public/balance/post.test.ts`                   |
| Child capability and price | `src/shared/booking/model.ts`, `fold-tree.ts`, `price-tree.ts`, package API and day-selector callers                                       | `test/shared/booking/`, `test/features/api/packages/detail.test.ts`, day-selector template tests                                                      |
| Concealed API refusals     | `src/features/api/packages.ts`, the existing message catalogue                                                                             | A focused `test/features/api/packages/privacy.test.ts`, existing booking controls                                                                     |
| Root visibility            | `src/features/public/cart.ts`, `ticket-payment.ts`, `ticket-submit.ts`, all context callers                                                | `test/features/public/pages/robots.test.ts` and direct root-rule tests                                                                                |
| Shared date reads          | `src/features/public/pages.ts`, existing capacity snapshot functions                                                                       | `test/features/public/pages.test.ts`, `test/features/public/group-liveness.test.ts`                                                                   |
| Share eligibility          | Admin listing loaders, overview templates, QR routes, shared standalone eligibility                                                        | Admin listing, QR, and public QR tests across owner, manager, editor, and agent roles                                                                 |
| QR provider call count     | `test/features/public/qr-book/helpers.ts`                                                                                                  | `test/features/public/qr-book/submit.test.ts`                                                                                                         |

## Tests that prove the corrections

- Both mixed-cart visibility inversions, explicit hidden standalone roots,
  repeated roots, dropped roots, and final header removal.
- First balance return and replay with no external thank-you redirect for
  concealed, named, mixed, and quantity-zero original paths. Assert unchanged
  settlement and refund counts.
- Unavailable, deleted, and converted package cancellation, with live named
  alternatives as controls.
- Public balance names and amounts, with raw admin detail unchanged.
- The 500-versus-2500 price case, fixed daily mismatch, free zero, pay-more
  minimum, and member-quantity multiplication.
- Identical concealed API refusal status and body for member guesses, child
  guesses, invalid totals, invalid prices, and missing required contact data.
  Validation-only cases create no reservation, checkout, or notification.
- One versus seventeen capped daily packages, and one versus ninety-day spans,
  with constant capacity-read counts and correct per-listing results.
- Inactive controls and target refusals, reactivation, and active hidden,
  closed, full, and standalone-child controls across permitted roles.
- Exactly one checkout call for the signed-price QR POST.

## Delivery and budgets

Implement the hardest invariant first: payment-path disclosure. Follow with
shared capacity reads, pricing/API refusals, root visibility, and share
controls. Each slice replaces its old path in the same change. No unused
foundation lands.

| Corrective slice                      | Planned source churn, excluding tests | Database/provider effect                                                                     |
| ------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Balance returns and public recap      | 60–120 changed source lines           | One signed-intent check for the suppress decision and one package-display read for the recap |
| Shared daily capacity                 | 60–100 changed source lines           | One capacity snapshot for every package and span                                             |
| Child capability and API refusals     | 80–140 changed source lines           | No additional database or provider calls                                                     |
| Root visibility and share eligibility | 80–140 changed source lines           | Existing root facts and batched child eligibility, no per-item reads                         |

These are planning estimates, not measured results. Measure the final combined
diff against fresh `main`. If it exceeds the repository source budget, stop and
present complete vertical PR boundaries before further implementation.

The capped daily capacity stage targets three database round trips when
membership is already known. The controlled handler fixture has a source-derived
estimate of thirteen calls. Tests must establish the actual count. Request paths
with provider calls retain the forty-database-call target.

Synchronise the branch with current `main` before the final candidate. Use a
non-destructive update and preserve user changes. Update PR #2259's title,
description, scope, source counts, and validation evidence.

## Adversarial review

- A synthetic balance line cannot represent several original purchase paths.
  Read the stored rows instead of adding one misleading package tag.
- A live standalone page is not permission to disclose a concealed purchase.
  Check both path permission and destination existence.
- Cancellation metadata cannot authorise a new capability. Use the home action
  for balance cancellation under the proposed policy.
- An unavailable child span is not a free alternative. Share capability checks
  without creating a price/fold import cycle.
- Masking only two English error strings leaves other failed-request probes.
  Apply the approved refusal policy once at the concealed package boundary.
- A widest-span snapshot must still evaluate shorter listings over shorter
  prefixes. Do not apply ninety-day demand to every listing.
- Hidden, inactive, closed, and full are different facts. Do not replace
  standalone eligibility with public discovery visibility.
- The price fix does not introduce a global allocation optimiser. The API
  refusal fix does not promise complete relationship secrecy.

## Validation limits

Local validation remains restricted to small individual tests and focused
formatting. Precommit and mutation runs remain paused until the owner gives the
go-ahead. No complete final-gate result is claimed by this plan.
