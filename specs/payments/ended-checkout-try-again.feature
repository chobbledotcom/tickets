@story:payments.ended-checkout-try-again
@owner:payments @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
Feature: A checkout that has ended offers the buyer a way back
  An unpaid checkout can no longer take payment once its window has
  passed. A buyer who comes back to it must not be left waiting for a
  payment that can never land.

  @rule:payments.ended-checkout-shows-try-again
  @surface:return
  Rule: A buyer who returns to an ended checkout sees the try-again page
    The page says the payment was cancelled and links back to the
    listing, so the buyer can start again.

    @case:ended-checkout.buyer-sees-try-again
    Scenario: The buyer returns after the checkout has ended
      Given a customer's unpaid checkout has ended without a payment
      When the customer comes back to the checkout
      Then they are told the payment was cancelled
      And they are offered a way to book again

  @rule:payments.open-checkout-still-waits
  @surface:return
  Rule: A buyer who returns to a checkout still open is asked to check again
    A checkout that can still take payment may confirm after the buyer
    leaves, so the page waits instead of calling the payment cancelled.

    @case:ended-checkout.open-checkout-keeps-waiting
    Scenario: The buyer returns while the checkout is still open
      Given a customer's checkout is still open and unpaid
      When the customer comes back to the checkout
      Then they are asked to check again shortly
      And they are not told the payment was cancelled
