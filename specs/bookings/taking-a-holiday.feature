@story:bookings.taking-a-holiday
@owner:bookings @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser takes a holiday
  When the organiser adds a holiday, its days disappear from every daily
  listing's date choices — nobody can book a day the doors are shut.
  Deleting the holiday opens the days straight back up, and things sold
  for one fixed moment are never touched by it.

  @rule:bookings.a-holiday-takes-its-days-off-the-menu
  @surface:public
  Rule: A holiday takes its days off the menu
    Adding a holiday is confirmed to the organiser, and from then on a daily
    listing's booking page offers none of the holiday's days. The days either
    side stay on offer.

    @case:holidays.the-closed-day-vanishes
    Scenario: The organiser closes one day
      Given the site sells day places at the Pottery
      When the organiser adds a holiday called "Spring break" on the day 5 days from now
      Then the organiser is told the holiday was created
      And the Pottery no longer offers the day 5 days from now
      But the Pottery still offers the day 4 days from now
      And the Pottery still offers the day 6 days from now

  @rule:bookings.deleting-a-holiday-reopens-its-days
  @surface:public
  Rule: Deleting a holiday opens its days straight back up
    The moment a holiday is deleted, the days it closed are offered again —
    no restart, no waiting.

    @case:holidays.deleting-reopens-the-day
    Scenario: The organiser deletes the holiday
      Given the site sells day places at the Pottery
      And the organiser has added a holiday called "Spring break" on the day 5 days from now
      When the organiser deletes the holiday "Spring break" typing its exact name
      Then the organiser is told the holiday was deleted
      And the Pottery offers the day 5 days from now again

  @rule:bookings.a-holiday-only-closes-things-sold-by-the-day
  @surface:public
  Rule: A holiday only closes things sold by the day
    A holiday closes daily listings and nothing else. Something sold as
    plain places — a gala, a show — still takes bookings right through
    the holiday.

    @case:holidays.the-gala-sells-through-the-holiday
    Scenario: A customer books the Gala during the holiday
      Given the site sells places at the Gala
      And the organiser has added a holiday called "Deep clean" covering today and the next 7 days
      When a customer books a place at the Gala
      Then the Gala keeps that booking
