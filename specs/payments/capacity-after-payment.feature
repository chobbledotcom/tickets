@story:payments.capacity-after-payment
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A paid booking loses the last available place
  A customer may finish payment after another customer takes the last place.
  The customer must not be lost or charged without a clear outcome.

  @rule:payments.available-place-is-booked
  Rule: A paid customer receives a ticket while a place remains
    Confirming the payment creates the promised booking.

    @case:payment.place-available
    Scenario: Payment is confirmed before the last place is taken
      Given a paid listing has one place left
      When a customer payment is confirmed
      Then the customer receives a ticket

  @rule:payments.late-customer-is-kept-and-refunded
  Rule: A paid customer who loses the place is kept and refunded once
    The organiser can see the customer and the reason no place was booked.

    @case:payment.place-lost
    Scenario: Another customer takes the last place before confirmation
      Given a paid listing became full while a customer paid
      When the late payment confirmation arrives
      Then the late customer is kept without a quantity
      And the late payment is refunded once
      And the organiser can see why the booking failed

    @case:payment.late-confirmation-repeated
    Scenario: The losing confirmation arrives again
      Given a late paid booking was already kept and refunded
      When the same payment confirmation arrives again
      Then no second customer record is made
      And no second refund is sent
      And the same final result is returned
