@story:bookings.agreeing-to-the-terms-before-booking
@owner:bookings @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
Feature: A customer agrees to the terms before booking
  The site can ask everybody who books to agree to its terms first. When it
  asks, the terms are shown on the booking page with a box beside them, and
  no order can leave the page with the box clear. When it asks nothing, the
  page offers no box and booking works as it always did.

  @rule:bookings.the-terms-are-shown-and-the-box-is-insisted-on
  Rule: The terms are shown, and the box is insisted on
    The words the site agreed with its organiser are shown, and a box beside
    them carries the agreement. The page insists on that box, so a browser
    will not send an order with it clear — one page or several things in
    one order, the insistence is the same.

    @case:terms.terms-and-box-shown-together
    Scenario: The page shows the terms and a box to agree to them
      Given a Ticket to book, where orders must agree to terms first
      Then the Ticket page shows the terms and a box to agree to them
      And the Ticket page insists the terms box is ticked before it will send

    @case:terms.joint-order-box-insisted-on
    Scenario: An order of two things insists on the same box
      Given a Ticket to book, where orders must agree to terms first
      And the shop also sells a Mug
      Then the page selling both shows the terms and a box to agree to them
      And the page selling both insists the terms box is ticked before it will send

  @rule:bookings.an-agreed-order-books-every-part
  Rule: An agreed order books every part
    One agreement covers a whole order: agreeing once books every thing in
    it, exactly one place on each.

    @case:terms.agreed-order-goes-through
    Scenario: A customer agrees and books
      Given a Ticket to book, where orders must agree to terms first
      When a customer tries to book the Ticket agreeing to the terms
      Then the customer is thanked for their order
      And one place was booked on the Ticket

    @case:terms.joint-order-booked-with-agreement
    Scenario: An order of two things with the agreement
      Given a Ticket to book, where orders must agree to terms first
      And the shop also sells a Mug
      When a customer tries to order the Ticket and the Mug agreeing to the terms
      Then the customer is thanked for their order
      And one place was booked on the Ticket
      And one place was booked on the Mug

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
      And one place was booked on the Ticket
