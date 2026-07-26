@story:payments.paying-for-a-mixed-order
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: One payment covers a mixed order
  When a customer pays for a bundle and extra things in one go, that single
  payment has to cover every part of the order. Each listing must earn what it
  sold for on every path it was sold through, and the customer must be left
  owing nothing.

  @rule:payments.one-payment-settles-every-part-of-an-order
  @surface:admin
  Rule: One payment settles every part of a mixed order
    A listing sold both inside a bundle and on its own earns from both, and the
    order is paid in full.

    @case:mixed-order.one-payment-settles-it-all
    Scenario: A customer pays for a bundle plus extra items
      Given a Deluxe Kit holding a 4.00 Cabin and a 6.00 Lodge, and Hampers at 15.00
      When a customer pays for one kit, another Cabin, and 2 Hampers in one order
      Then the customer owes nothing
      And the Cabin has earned 8.00 — once in the kit and once on its own
      And the Hampers have earned 30.00
      And the organiser sees the Cabin booked both ways
