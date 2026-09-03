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

  Square's sandbox has no hosted buyer card page, so its driver completes the
  exact sandbox payment through the Square Payments API before the visitor
  browser follows the real application return URL. SumUp's callback is
  self-delivered by the harness with the genuine checkout id; the harness does
  not claim to prove SumUp's own webhook delivery.

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
      And the owner's system map answers clean

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
      And the owner's system map answers clean

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
      And no second Refund action is available
      And the owner's system map answers clean

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
      And no second Refund action is available
      And the owner's system map answers clean

  @rule:payments.live-sumup-return-pending-is-waited @surface:public @surface:return @surface:webhook
  Rule: A SumUp return that lands before the payment is confirmed ends well
    SumUp can send the visitor home before it confirms the payment. The
    visitor is told the payment is not confirmed yet, and the page keeps
    checking for them on the same return. No error is recorded. When the
    timed checks run out, one click on Check again opens a fresh window.
    Once the payment is confirmed, the same return shows their booking.

    @case:live-payments.sumup-return-pending
    Scenario: A visitor returns before SumUp confirms the payment
      Given SumUp is configured with dedicated sandbox credentials
      And the owner has published a priced listing
      When a separate visitor goes to SumUp's hosted checkout
      And the visitor opens the payment return before paying
      Then the visitor is told the payment is not confirmed yet
      And the page keeps checking for the visitor
      And the page schedules its next check on the exact return
      And the page checks again by itself
      And no payment error is logged
      When the visitor opens the waiting page's last timed check
      Then only the visitor's click on Check again starts the checking again
      When the visitor pays on SumUp's hosted checkout
      And the genuine checkout callback is delivered twice
      And the visitor retries the exact payment return
      Then the visitor sees the booking confirmation
      And the owner sees one attendee and the captured income once
      And the owner's system map answers clean

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
