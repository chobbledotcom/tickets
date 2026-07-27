@story:bookings.changes-after-people-have-booked
@owner:bookings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A listing changes after people have already booked
  An organiser can close a day of the week, or make stays longer than the
  window the listing takes bookings for. Either way, the people who already
  booked keep the days they were sold; only new bookings are turned away.

  @rule:bookings.closing-a-day-leaves-booked-stays-alone
  @surface:admin
  Rule: Closing a day of the week leaves the stays already booked alone
    A stay booked before the day was closed keeps every day it covers. Only new
    stays are kept off it.

    @case:changes.a-closed-weekday-keeps-the-stay
    Scenario: The organiser stops opening on a day a stay already covers
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      And a customer booked a Cabin stay starting in 10 days
      When the organiser stops opening the Cabin on the second day of that stay
      Then the organiser sees the stay runs for 3 days
      And the Cabin no longer offers a start day 10 days from now

  @rule:bookings.a-stay-stretched-past-the-booking-window-is-kept
  @surface:admin
  Rule: A stay stretched past how far ahead people can book is still kept
    Making stays longer can push one already booked past the last day the
    listing takes bookings for. That stay was sold in good faith, so it keeps
    its days — but no new stay can start there.

    @case:changes.a-stay-stretched-past-the-window
    Scenario: The organiser makes stays longer than the booking window allows
      Given a Cabin that takes bookings 10 days ahead, 1 day at a time
      And a customer booked a Cabin stay starting in 9 days
      When the organiser makes each Cabin stay 5 days long
      Then the organiser sees that stay now runs for 5 days
      And the Cabin no longer offers a start day 9 days from now
