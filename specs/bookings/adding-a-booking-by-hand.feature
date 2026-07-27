@story:bookings.adding-a-booking-by-hand
@owner:bookings @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser adds a booking themselves
  An organiser can add a booking for someone who rang up or paid in cash. A
  booking added this way is a real booking: it holds the same days as one made
  through the site, and it is refused when those days have no room.

  @rule:bookings.a-booking-added-by-hand-holds-the-whole-stay
  @surface:admin
  Rule: A booking added by hand holds the listing's whole stay
    The organiser only says which day the stay starts. The listing decides how
    many days it covers, and every one of those days is held.

    @case:by-hand.holds-the-whole-stay
    Scenario: The organiser adds a booking to a three-day listing
      Given a Cabin that is booked 3 days at a time, with room for 1 place a day
      When the organiser adds a Cabin booking starting in 10 days
      Then the organiser sees the stay runs for 3 days
      And no Cabin stay can start on any of those 3 days
      And a Cabin stay can still start the day after it ends

  @rule:bookings.a-booking-by-hand-is-refused-when-a-day-is-full
  @surface:admin
  Rule: A booking added by hand is refused when any day it needs is full
    The days in the middle of a stay count as much as the first one, so a stay
    that reaches a full day cannot be added at all.

    @case:by-hand.refused-when-a-later-day-is-full
    Scenario: The organiser adds a stay that reaches a full day
      Given a Cabin that is booked 3 days at a time, with room for 1 place a day
      And a customer booked a Cabin stay starting in 11 days
      When the organiser adds a Cabin booking starting in 10 days
      Then the organiser is told the days have no room
      And no new Cabin booking was added
