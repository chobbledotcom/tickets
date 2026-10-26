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

  @rule:payments.a-bundle-charges-a-blank-part-at-its-own-price
  Rule: A part with a blank bundle price charges its own price
    A bundle price is blank when the part should simply sell for what it
    always costs. A buyer who pays for that bundle is charged the overridden
    part's bundle price plus the blank part's own price — never nothing for
    the blank part.

    @case:mixed-order.a-blank-part-charges-its-own-price
    Scenario: A customer pays for a bundle holding an overridden part and a blank one
      Given a Weekend holding a Tent at 40.00, sold in it at 25.00, and a Breakfast at 10.00 with no Weekend price
      When a customer pays for one Weekend in one order
      Then the customer owes nothing
      And the Tent has earned 25.00 in the Weekend
      And the Breakfast has earned 10.00 in the Weekend
