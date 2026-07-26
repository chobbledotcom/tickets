@story:bookings.day-limits-shared-across-listings
@owner:bookings @risk:high
@actor:customer
@edition:managed @edition:self-hosted
Feature: Listings that share a day limit are counted together
  An organiser can cap how many places go in a day across several listings at
  once — a whole site, a whole venue. A stay that covers two days counts towards
  both of those days, and one order that books two listings at once is checked
  against the same limit before any of it is taken.

  @rule:bookings.a-stay-counts-towards-every-shared-day-it-covers
  Rule: A stay counts towards the shared limit of every day it covers
    A two-day stay takes room from both days, so the first day can fill up while
    the second still has space.

    @case:shared-days.first-day-fills-across-listings
    Scenario: Stays on two listings fill the first day between them
      Given a Saturday and a Weekend listing sharing 10 places a day
      And 5 Saturday places and 5 Weekend places are booked starting in 10 days
      When a customer tries to book 1 more Saturday place starting in 10 days
      Then they are told the Saturday has no room for those days

    @case:shared-days.second-day-still-has-room
    Scenario: The second day only carries the stay that reaches it
      Given a Saturday and a Weekend listing sharing 10 places a day
      And 5 Saturday places and 5 Weekend places are booked starting in 10 days
      When a customer books 5 Weekend places starting in 11 days
      Then the Weekend holds 2 stays of 5 places

  @rule:bookings.one-order-is-checked-against-the-shared-limit
  Rule: One order booking two listings is refused when a shared day goes over
    Both parts of the order are counted together on the days they share, and
    nothing is taken when the limit would break.

    @case:shared-days.a-mixed-order-over-the-limit-is-refused
    Scenario: One order books two stays of different lengths
      Given a Short and a Long listing sharing 3 places a day
      When a customer tries to book 2 Short places and 2 Long places in one order
      Then the order is refused and nothing is booked
