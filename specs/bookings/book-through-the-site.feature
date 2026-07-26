@story:bookings.book-through-the-site
@owner:bookings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A customer books a listing the organiser set up
  An organiser builds a listing, asks the customer a question, and shows the
  listing on a group page. A customer books a place, keeps a ticket, and the
  organiser sees the booking and the answer.

  @rule:bookings.group-page-takes-a-booking
  @surface:admin
  Rule: A booking made on a group page reaches the organiser in full
    The customer keeps a ticket, and the organiser sees the person, their
    contact details, and the answer they chose.

    @case:booking.group-page-journey
    Scenario: A customer books a place on a group page
      Given the organiser has a Summer Concert listing in the Summer Festival group that asks for a t-shirt size
      When a customer books one Summer Concert place and picks the Medium size
      Then the customer can open a ticket for Summer Concert
      And the Summer Concert attendee list shows the customer and their email
      And the Summer Concert list download shows the customer picked Medium
