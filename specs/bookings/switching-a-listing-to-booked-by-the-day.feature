@story:bookings.switching-a-listing-to-booked-by-the-day
@owner:bookings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser switches a listing to booked by the day
  A listing that sells one date can become one that sells by the day. The
  people who booked it before hold no day of their own, and a daily listing
  counts its room day by day — so the switch asks the organiser to give every
  booking a day first. The organiser picks one date, and saving moves all of
  those bookings to it and finishes the switch. A date can only take them
  when it has room for them all. Leaving without giving a day changes
  nothing.

  @rule:bookings.the-switch-asks-for-a-day-for-every-booking
  @surface:admin
  Rule: The switch asks for a day before it can finish
    The page names how many bookings have no day and offers one date to move
    them all to. Until a day is given, nothing is saved: the listing stays an
    ordinary one and every booking keeps its places.

    @case:stay-length.turning-day-bookings-on-keeps-everyone-booked
    Scenario: The organiser turns a fully booked listing into a by-the-day one
      Given a Workshop that is not booked by the day, with room for 2 places
      And two customers have each booked a Workshop place
      When the organiser puts the Workshop on the day calendar
      Then the organiser is asked to give the 2 bookings a day
      And the Workshop is still not booked by the day

    @case:switch-to-daily.leaving-without-assigning-changes-nothing
    Scenario: The organiser leaves the page without giving a day
      Given a Workshop that is not booked by the day, with room for 2 places
      And two customers have each booked a Workshop place
      When the organiser puts the Workshop on the day calendar
      And the organiser goes back to the Workshop's page without giving a day
      Then the Workshop is still not booked by the day
      And the Workshop's bookings still have no day
      And the Workshop attendee list still shows both customers

  @rule:bookings.giving-a-day-moves-every-booking-and-finishes-the-switch
  @surface:admin
  Rule: Giving a day moves every booking and finishes the switch
    Saving with a date moves every booking without a day to that date and
    completes the switch. From then on the listing counts its room day by
    day, and the bookings that moved take up room on their day.

    @case:switch-to-daily.assigning-a-day-completes-the-switch
    Scenario: The organiser gives the bookings their day
      Given a Workshop that is not booked by the day, with room for 2 places
      And two customers have each booked a Workshop place
      When the organiser puts the Workshop on the day calendar
      And the organiser gives the bookings the first day offered
      Then the Workshop is booked by the day
      And the Workshop attendee list still shows both customers
      And no Workshop place can be booked for that day

  @rule:bookings.a-day-without-room-is-refused
  @surface:admin
  Rule: A day without room for the bookings is refused
    A date takes the bookings only when it has room for them all. A day that
    cannot hold them is refused with its reason — the switch never overbooks
    — and the listing and its bookings stay as they were. When no date can
    hold them all, the page says so plainly instead of offering a pick that
    cannot work.

    @case:switch-to-daily.a-full-day-is-refused
    Scenario: The organiser gives the bookings a day that is already full
      Given a Lodge that is booked 1 day at a time, with room for 2 places a day
      And a customer booked a Lodge stay starting in 10 days
      When the organiser makes the Lodge an ordinary listing again, with room for 2 places
      And another customer books a Lodge place
      When the organiser puts the Lodge on the day calendar, with room for 1 place a day
      And the organiser gives the bookings the day the stay holds
      Then the organiser is told the Lodge has no room for the bookings that day
      And the Lodge is still not booked by the day
      And the Lodge's bookings still have no day

    @case:switch-to-daily.no-date-fits-says-so
    Scenario: The page says plainly when no date can hold the bookings
      Given a Hall that is not booked by the day, with room for 4 places
      And two customers have each booked a Hall place
      When the organiser puts the Hall on the day calendar, with room for 1 place a day
      Then the page says no date has room for all 2 bookings
      And the Hall is still not booked by the day
