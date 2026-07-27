@story:payments.what-a-paid-booking-earned
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser sees what a paid booking earned
  When someone pays for a place, the listing earns exactly what they paid, the
  customer owes nothing, and every page that shows the figure agrees. The
  booking is written down once — one sale and one payment, kept together.

  @rule:payments.a-paid-booking-is-recorded-once-and-every-page-agrees
  @surface:admin
  Rule: A paid booking is recorded once, and every page shows the same figure
    One sale and one payment, belonging to the same order. No booking fee is
    taken unless the organiser has set one up.

    @case:paid-booking.recorded-once
    Scenario: A customer pays 50.00 for a Workshop place
      Given a customer paid 50.00 for a Workshop place
      Then the Workshop earned 50.00 and the customer owes nothing
      And the booking holds one sale and one payment of 50.00, in one order
      And no booking fee was taken
      And every page shows the Workshop earning 50.00
