@story:bookings.agreeing-to-the-terms-before-booking
@owner:bookings @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
Feature: A customer agrees to the terms before booking
  The site can ask everybody who books to agree to its terms first. When it
  asks, the terms are shown on the booking page with a box beside them, and
  no order goes through until the box is ticked. When it asks nothing, the
  page offers no box and booking works as it always did.

  @rule:bookings.the-terms-are-shown-and-must-be-agreed-to
  Rule: The terms are shown on the page, and must be agreed to
    The words the site agreed with its organiser are shown, and a box beside
    them carries the agreement. An order sent without the agreement is
    refused for that reason and books nothing.

    @case:terms.terms-and-box-shown-together
    Scenario: The page shows the terms and a box to agree to them
      Given a Ticket to book, where orders must agree to terms first
      Then the Ticket page shows the terms and a box to agree to them

    @case:terms.refusal-names-the-terms
    Scenario: A customer books without agreeing
      Given a Ticket to book, where orders must agree to terms first
      When a customer tries to book the Ticket without agreeing to the terms
      Then the customer is told they must agree to the terms and conditions
      And nothing was booked on the Ticket

    @case:terms.agreed-order-goes-through
    Scenario: A customer agrees and books
      Given a Ticket to book, where orders must agree to terms first
      When a customer tries to book the Ticket agreeing to the terms
      Then the customer is thanked for their order

  @rule:bookings.one-agreement-covers-a-whole-order
  Rule: One agreement covers a whole order
    An order can cover several things at once. One set of terms and one box
    covers the whole order: agreeing once books every part of it, and
    sending without the agreement books none of it.

    @case:terms.joint-order-refused-without-agreement
    Scenario: An order of two things without the agreement
      Given a Ticket to book, where orders must agree to terms first
      And the shop also sells a Mug
      When a customer tries to order the Ticket and the Mug without agreeing to the terms
      Then the customer is told they must agree to the terms and conditions
      And nothing was booked on the Ticket
      And nothing was booked on the Mug

    @case:terms.joint-order-booked-with-agreement
    Scenario: An order of two things with the agreement
      Given a Ticket to book, where orders must agree to terms first
      And the shop also sells a Mug
      When a customer tries to order the Ticket and the Mug agreeing to the terms
      Then the customer is thanked for their order

  @rule:bookings.a-site-that-asks-nothing-adds-no-box
  Rule: A site that asks nothing adds no box
    With no terms set, the booking page offers nothing to agree to, and an
    order goes through without one.

    @case:terms.no-box-without-terms
    Scenario: The site asks nothing
      Given a Ticket to book
      Then the Ticket page offers no box to agree to
      When a customer tries to book the Ticket
      Then the customer is thanked for their order
