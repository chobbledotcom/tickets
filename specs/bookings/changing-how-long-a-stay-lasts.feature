@story:bookings.changing-how-long-a-stay-lasts
@owner:bookings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser changes how long a stay lasts
  An organiser can change how many days each stay on a listing covers. Stays
  already booked are stretched or shortened to match, so the calendar and the
  bookings never disagree — except where the customer chose the length
  themselves, which is theirs to keep.

  @rule:bookings.a-longer-stay-stretches-bookings-already-made
  @surface:admin
  Rule: Making stays longer stretches the stays already booked
    The days a stretched stay now covers are held, so nobody else can book them.

    @case:stay-length.longer-stretches-existing-stays
    Scenario: The organiser makes stays three days instead of one
      Given a Lodge that is booked 1 day at a time, with room for 1 place a day
      And a customer booked a Lodge stay starting in 10 days
      When the organiser makes each Lodge stay 3 days long
      Then the organiser sees that stay now runs for 3 days
      And a Lodge stay can no longer start in 11 days

  @rule:bookings.a-shorter-stay-frees-the-days-at-the-end
  @surface:admin
  Rule: Making stays shorter frees the days at the end
    The days the stay no longer covers go back on the calendar for anyone.

    @case:stay-length.shorter-frees-the-later-days
    Scenario: The organiser makes stays two days instead of five
      Given a Lodge that is booked 5 days at a time, with room for 1 place a day
      And a customer booked a Lodge stay starting in 10 days
      When the organiser makes each Lodge stay 2 days long
      Then the organiser sees that stay now runs for 2 days
      And a Lodge stay can start in 12 days again

  @rule:bookings.room-follows-the-stay-length-both-ways
  @surface:admin
  Rule: Room follows the stay length, however often it changes
    Stretching stays takes room from the later days, and shrinking them gives it
    back — even when more was booked in between.

    @case:stay-length.room-follows-a-stretch-then-a-shrink
    Scenario: The organiser stretches stays, takes another booking, then shrinks them back
      Given a Lodge that is booked 1 day at a time, with room for 2 places a day
      And a customer booked a Lodge stay starting in 10 days
      When the organiser makes each Lodge stay 3 days long
      And a customer books a Lodge stay starting in 10 days
      Then no Lodge stay can start on any of those 3 days
      When the organiser makes each Lodge stay 1 day long
      Then a Lodge stay can start in 11 days again
      And a Lodge stay can start in 12 days again
      And a Lodge stay can no longer start in 10 days

  @rule:bookings.a-length-change-that-breaks-a-shared-limit-is-flagged
  @surface:admin
  Rule: The organiser is warned when a longer stay breaks a shared day limit
    Listings that share a limit are counted together. When stretching one of
    them takes a shared day over its limit, the change is saved and the
    organiser is told which day is over, so they can put it right.

    @case:stay-length.shared-limit-warning
    Scenario: Stretching one listing takes a shared day over its limit
      Given two Retreat listings sharing a limit of 10 places a day
      And 6 places are booked on the first for a day, and 6 on the second for the next day
      When the organiser makes each stay on the first listing 2 days long
      Then the organiser is warned that the shared day is over its limit
      And the warning is kept in the listing's history

  @rule:bookings.a-stay-the-customer-sized-is-never-rewritten
  @surface:admin
  Rule: A stay the customer chose the length of is left alone
    Some listings let the customer pick how many days they want. Changing the
    longest stay the listing allows must never rewrite what they chose.

    @case:stay-length.customer-chosen-length-survives
    Scenario: The organiser changes the longest stay a listing allows
      Given a Retreat where customers pick up to 5 days themselves
      And a customer booked a 2-day Retreat stay starting in 10 days
      When the organiser lowers the longest Retreat stay to 4 days
      Then the organiser sees that stay still runs for 2 days
