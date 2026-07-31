@story:bookings.booking-several-days
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer books a stay of several days
  Some listings are booked by the day, and one booking covers several days in a
  row. The booking page says up front how many days each booking reserves.
  Every day a stay covers must be held for that customer, and a stay must
  never be taken when one of the days it needs is already full — even when
  customers pick their own lengths and a short stay meets a longer one.

  @rule:bookings.the-booking-page-says-how-long-a-stay-lasts
  Rule: The booking page says how long each booking lasts
    A customer picking a first day is told each booking reserves several days,
    so the length is never a surprise. A listing booked one day at a time does
    not bring it up.

    @case:stay.the-page-says-a-booking-reserves-three-days
    Scenario: A customer looks at a listing booked three days at a time
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      When a customer looks at the days the Cabin offers
      Then they are told each booking reserves 3 days

    @case:stay.a-one-day-listing-keeps-quiet-about-length
    Scenario: A customer looks at a listing booked one day at a time
      Given a Cabin that is booked 1 day at a time, with room for 5 places a day
      When a customer looks at the days the Cabin offers
      Then nothing tells them a booking reserves more than one day

  @rule:bookings.a-stay-holds-every-day-it-covers
  Rule: A stay holds every day it covers
    The days in the middle and at the end are held just like the first day. The
    day after a stay ends is free, so one stay can start the day the last ends.

    @case:stay.a-three-day-stay-holds-three-days
    Scenario: A customer books a three-day stay
      Given a Cabin that is booked 3 days at a time, with room for 1 place a day
      When a customer books a Cabin stay starting in 10 days
      Then the organiser sees the stay runs for 3 days
      And no Cabin stay can start on any of those 3 days
      And a Cabin stay can still start the day after it ends

  @rule:bookings.a-full-day-blocks-a-stay-that-needs-it
  Rule: A stay cannot be booked when one of its days is already full
    A full day blocks every stay that would cover it, even when the two stays
    start on different days. Days no stay has reached can still be booked.

    @case:stay.an-overlapping-stay-is-refused
    Scenario: A would-be stay overlaps the end of one already booked
      Given a Cabin that is booked 3 days at a time, with room for 1 place a day
      And a customer booked a Cabin stay starting in 11 days
      When another customer tries to book a Cabin stay starting in 10 days
      Then they are told the Cabin has no room for those days
      And a Cabin stay starting in 8 days can still be booked

  @rule:bookings.places-on-the-same-days-add-up
  Rule: Places on the same days add up towards each day's room
    Two stays over the same days share those days' room, and the stay that would
    take a day past its limit is refused before it is booked.

    @case:stay.places-add-up-within-the-limit
    Scenario: Two stays fit within the room each day has
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      And a customer booked 2 Cabin places starting in 10 days
      When another customer books 2 Cabin places starting in 10 days
      Then the Cabin holds 2 stays of 2 places

    @case:stay.the-stay-over-the-limit-is-refused
    Scenario: A third stay would take those days over their limit
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      And two customers each booked 2 Cabin places starting in 10 days
      When a customer tries to book 2 Cabin places starting in 10 days
      Then they are told the Cabin has no room for those days
      And the Cabin still holds only the 2 stays it had

  @rule:bookings.longer-stays-leave-fewer-days-to-start-on
  Rule: Longer stays leave fewer days to start on
    A stay has to finish inside the window the listing takes bookings for, so
    the longer each stay is, the fewer days it can start on.

    @case:stay.a-longer-stay-offers-fewer-start-days
    Scenario: Two listings take bookings the same distance ahead
      Given a Cabin that is booked 1 day at a time, with room for 5 places a day
      And a Lodge that is booked 5 days at a time, with room for 5 places a day
      When a customer looks at the days the Cabin offers
      And a customer looks at the days the Lodge offers
      Then the Lodge offers fewer days to start on than the Cabin
      And the Lodge still offers some days

  @rule:bookings.stays-of-different-lengths-share-the-days
  Rule: Stays of different lengths share each day's room
    Where customers pick how many days they want, a short stay and a long stay
    can want the same day. A day one customer has filled blocks every longer
    stay that would cover it, while the days around it stay open.

    @case:stay.a-short-stay-blocks-a-longer-one-needing-its-day
    Scenario: A one-day stay blocks a three-day stay that needs its day
      Given a Retreat where customers pick up to 3 days themselves, with room for 1 place a day
      And a customer booked a 1-day Retreat stay starting in 11 days
      When another customer tries to book a 3-day Retreat stay starting in 10 days
      Then they are told the Retreat has no room for those days
      And a 1-day Retreat stay starting in 10 days can still be booked
      And a 1-day Retreat stay starting in 12 days can still be booked

  @rule:bookings.only-one-of-two-stays-booked-at-once-is-taken
  Rule: Only one of two stays booked at the same moment is taken
    Two customers can press Continue on the last place at the same moment. One
    of them gets it and the other is refused — the day never goes over.

    @case:stay.two-customers-race-for-the-last-stay
    Scenario: Two customers book the last stay at the same moment
      Given a Cabin that is booked 2 days at a time, with room for 1 place a day
      When two customers try to book a Cabin stay starting in 10 days at once
      Then only one of them got the stay

  @rule:bookings.a-stay-cannot-run-into-a-closed-day
  Rule: A stay is never offered a start day that runs into a closed day
    A holiday closes a day. A stay that would cover it cannot start, even when
    the closed day is the last day of the stay rather than the first.

    @case:stay.a-holiday-in-the-tail-removes-the-start-day
    Scenario: A holiday falls on the last day of a would-be stay
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      And the organiser closes the day 12 days from now for a holiday
      When a customer looks at the days the Cabin offers
      Then the closed day is not offered
      And the day 10 days from now is not offered either
      And the day 13 days from now is still offered
