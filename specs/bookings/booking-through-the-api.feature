@story:bookings.booking-through-the-api
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: Another system books a stay through the booking API
  An organiser can let another system book on their customers' behalf — a
  website of their own, or a partner's. What that system is told, and what it is
  allowed to book, must match what a customer would get on the site itself.

  @rule:bookings.a-stay-booked-through-the-api-holds-its-days
  Rule: A stay booked through the API holds every day it covers
    The system asks which days are open, books one, and gets a ticket back. The
    stay it made is a real stay: it covers the listing's whole length, and those
    days are held against everyone else.

    @case:api.a-stay-booked-through-the-api
    Scenario: Another system books a three-day stay
      Given the organiser opens the booking API
      And a Cabin that is booked 3 days at a time, with room for 1 place a day
      When another system books the first Cabin day the API offers
      Then the system is given a ticket
      And the organiser sees the stay runs for 3 days
      And no Cabin stay can start on any of those 3 days

  @rule:bookings.the-api-refuses-a-stay-that-reaches-a-full-day
  Rule: The API refuses a stay that reaches a day with no room
    A system asking about a day is told the truth, and a system that books
    anyway is refused — the same rule the site's own pages follow.

    @case:api.a-full-middle-day-is-refused
    Scenario: The middle day of the stay is already full
      Given the organiser opens the booking API
      And a Cabin that is booked 3 days at a time, with room for 2 places a day
      And 2 Cabin places are booked for one day, on the second day the API offers
      When another system asks about the first Cabin day the API offers
      Then the API says there is no room
      And booking that day anyway is refused
      And the Cabin holds only the 1 stay it already had
