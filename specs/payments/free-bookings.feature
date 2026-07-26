@story:payments.free-bookings
@owner:payments @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A free booking costs nothing
  A listing given away for free must never invent money, whatever fees the site
  charges on its paid listings.

  @rule:payments.a-free-booking-records-no-money
  @surface:admin
  Rule: A free booking records no money at all
    Even with a booking fee set up, nothing is charged and nothing is recorded.

    @case:payment.free-booking-records-no-money
    Scenario: A customer books a free place while a booking fee is set up
      Given the site adds a 10 percent booking fee
      When a customer books a free Free Meetup place
      Then no money is recorded for the booking
      And no booking fee is recorded
