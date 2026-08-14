@story:payments.refunding-a-booking
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser refunds a booking
  When an organiser refunds a booking, the customer gets back everything they
  paid — the ticket, any booking fee, and any service charge. The organiser's
  own figures must agree with the money that actually moved.

  @rule:payments.refund-hands-the-money-back
  @surface:admin
  Rule: A refund hands back the money and undoes the sale
    The listing stops counting the sale, the customer owes nothing, and the
    money goes back where it came from.

    @case:payment.refund-undoes-the-sale
    Scenario: The organiser refunds a paid place
      Given a customer paid 45.00 for a Concert place
      When the organiser refunds the booking
      Then the customer is handed back 45.00 once
      And the Concert has earned nothing and the customer owes nothing
      And the booking page says the booking is fully paid

  @rule:payments.a-booking-is-refunded-once-only
  @surface:admin
  Rule: A booking can only be refunded once
    A second attempt is refused before any money moves, so nobody is paid twice.

    @case:payment.second-refund-is-refused
    Scenario: The organiser tries to refund the same booking twice
      Given a customer's paid Concert place was already refunded
      When the organiser tries to refund it again
      Then the organiser is told it was already refunded
      And the payment provider is not asked again
      And the customer was handed money back only once

  @rule:payments.a-booking-fee-is-its-own-income
  @surface:admin
  Rule: A booking fee is counted apart from the ticket, and comes back too
    The fee the site charges is its own income, not the listing's, and a refund
    returns it with the ticket.

    @case:payment.booking-fee-is-counted-apart
    Scenario: A customer pays a booking fee
      Given the site adds a 10 percent booking fee
      When a customer pays 55.00 for a 50.00 Fee Day place
      Then the Fee Day place has earned 50.00 and the booking fee has earned 5.00
      And the customer owes nothing

    @case:payment.booking-fee-comes-back
    Scenario: The organiser refunds a booking that paid a booking fee
      Given a customer paid a 10 percent booking fee on a 50.00 Fee Day place
      When the organiser refunds the booking
      Then the Fee Day place and the booking fee have both earned nothing
      And the site is holding none of the customer's money

  @rule:payments.a-service-charge-earns-and-returns
  @surface:admin
  Rule: A service charge earns its own money, and comes back on a refund
    An extra charge added at checkout is tracked on its own, and the organiser
    can see what it earned.

    @case:payment.service-charge-earns-its-own-money
    Scenario: A customer pays a service charge
      Given a Talk place costs 50.00 and adds a 10 percent Service charge
      When a customer pays for one Talk place
      Then the Service charge has earned 5.00
      And the organiser's pages show the Service charge earnings

    @case:payment.service-charge-comes-back
    Scenario: The organiser refunds a booking that paid a service charge
      Given a customer paid a 10 percent Service charge on a 50.00 Talk place
      When the organiser refunds the booking
      Then the Service charge has earned nothing
      And the customer has the whole 55.00 back
      And no money is left unaccounted for

  @rule:payments.money-is-never-created-or-destroyed
  @surface:admin
  Rule: Money is never created or destroyed
    However many sales, corrections and refunds happen, the books still add up.

    @case:payment.mixed-sequence-still-adds-up
    Scenario: A sale, a correction and a refund in turn
      Given two customers each paid 70.00 for a Festival place
      And the organiser corrected the Festival income to 100.00
      When the organiser refunds the first customer
      Then no money is left unaccounted for
      And the Festival earnings and the refunded customer's balance agree

  @rule:payments.a-turned-down-refund-changes-nothing
  @surface:admin
  Rule: A refund the provider turns down changes nothing
    The organiser is told it failed, and the books are exactly as they were.

    @case:payment.declined-refund-changes-nothing
    Scenario: The payment provider turns down the refund
      Given a customer paid 45.00 for a Show place
      When the organiser asks for a refund and the provider turns it down
      Then the organiser is told the refund failed and shown what needs attention
      And the Show has still earned 45.00 and no money was handed back
