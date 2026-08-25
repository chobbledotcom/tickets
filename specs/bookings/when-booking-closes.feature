@story:bookings.when-booking-closes
@owner:bookings @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: Booking closes at the time the organiser set
  A listing can stop taking bookings at a moment the organiser chose. After
  that moment the page tells everybody that registration is closed and offers
  no way to book. An order sent in the last second is refused — even one that
  was already filled in when the moment passed.

  @rule:bookings.a-closed-listing-offers-no-way-to-book
  Rule: A closed listing offers no way to book
    The page says registration is closed, and there is nothing on it to fill
    in or send. Until the moment arrives, the page works as it always did.

    @case:closes.closed-page-says-so
    Scenario: Registration closed yesterday
      Given a Trip that stopped taking bookings yesterday
      Then the customer opening the Trip page is told registration is closed
      And the page offers no way to book

    @case:closes.still-open-until-the-moment
    Scenario: Registration closes tomorrow
      Given a Trip that stops taking bookings tomorrow
      Then the customer can fill the Trip page in

  @rule:bookings.one-part-of-an-order-can-be-closed
  Rule: One part of an order can be closed while the rest stays open
    An order can cover several things at once. The closed one is labelled on
    the page and cannot be booked; the open one beside it still can.

    @case:closes.closed-part-labelled
    Scenario: One of two things in an order is closed
      Given a Trip that stopped taking bookings yesterday
      And the shop also sells a Mug
      Then the page selling both says the Trip is closed
      And the page still lets the customer book the Mug

    @case:closes.whole-order-closed
    Scenario: Everything in an order is closed
      Given a Trip and a Mug that stopped taking bookings yesterday
      Then the page selling both is closed to booking

  @rule:bookings.an-order-sent-after-closing-is-refused
  Rule: An order sent after closing is refused
    A page already filled in can be sent after the moment passed. The
    customer is told what happened, and no part of the order is booked.

    @case:closes.closed-while-submitting
    Scenario: The Trip closes while the customer is sending
      Given a Trip that stops taking bookings tomorrow
      And a customer filled the Trip page in, asking for 2 places
      When the organiser closes the Trip to bookings
      And the customer sends the form
      Then the customer is told registration closed while they were submitting
      And nothing was booked on the Trip

    @case:closes.closed-while-submitting-in-an-order
    Scenario: One part of an order closes while the customer is sending
      Given a Trip that stops taking bookings tomorrow
      And the shop also sells a Mug
      And a customer filled the page selling the Trip and the Mug in, asking for one of each
      When the organiser closes the Trip to bookings
      And the customer sends the form
      Then the customer is told registration closed while they were submitting
      And nothing was booked on the Trip
      And nothing was booked on the Mug
