@story:payments.no-tax-on-ordinary-bookings
@owner:payments @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The books carry no tax for ordinary bookings
  A booking records VAT only when it carries tax facts. The
  bookings the site takes today carry none, so a sale keeps its whole price
  as income and its refund hands back exactly what was paid.

  @rule:payments.a-booking-without-tax-facts-records-no-tax
  @surface:admin
  Rule: A booking without tax facts records no tax
    The tax account stays empty, and the customer owes nothing beyond the
    price they paid.

    @case:payment.no-tax-when-a-place-is-sold
    Scenario: A customer buys a place at its listed price
      Given a customer paid 45.00 for a Concert place
      Then no VAT was recorded or refunded
      And the customer owes nothing

  @rule:payments.a-refund-of-a-tax-free-booking-reverses-no-tax
  @surface:admin
  Rule: A refund of a booking that carried no tax reverses no tax
    The refund mirrors the legs the booking posted, and the books still add
    up.

    @case:payment.no-tax-when-a-place-is-refunded
    Scenario: The organiser refunds a place that carried no tax
      Given a customer paid 45.00 for a Concert place
      When the organiser refunds the booking
      Then no VAT was recorded or refunded
      And no money is left unaccounted for
