@story:bookings.ordering-several-things-at-once
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer orders several things at once
  An organiser can sell things in bundles, as add-ons to something bigger, on
  their own, and by the day. A customer can put all of those in one order — and
  can order the same thing more than one way. Each way must be kept as its own
  booking, so the organiser can see what was ordered and how. The order is
  taken whole or not at all, and everything in it booked by the day shares the
  one day the customer picks.

  @rule:bookings.each-way-of-ordering-is-its-own-booking
  @surface:admin
  Rule: Ordering the same thing two ways keeps the two apart
    A thing ordered inside a bundle and again on its own is two bookings, not
    one of two. The same holds for an add-on ordered under its parent and on
    its own. Each one says where it came from.

    @case:order.one-order-of-every-kind
    Scenario: A customer orders a bundle, an add-on, a plain item and a day booking
      Given the shop sells a Mega Kit bundle, a Marquee with a Generator add-on, T-Shirts, and a Campervan by the day
      When a customer orders all of them at once, adding a Tent and a Generator on their own
      Then the organiser sees the Tent twice — 2 in the bundle and 1 on its own
      And the organiser sees the Generator twice — under the Marquee and on its own
      And each booking says which bundle or parent it came from
      And every listing in the order lists the customer

  @rule:bookings.a-shared-item-is-booked-for-each-bundle
  @surface:admin
  Rule: Two bundles that both include a thing book it for each bundle
    Ordering both bundles books the shared thing twice, once for each, and the
    organiser can tell which booking belongs to which bundle.

    @case:order.two-bundles-share-an-item
    Scenario: A customer orders two bundles that both include a Tent
      Given the shop sells a Camp Kit and a Glamp Kit that both include a Tent
      When a customer orders one of each bundle
      Then the organiser sees a Tent booking for each bundle

  @rule:bookings.one-full-thing-turns-the-whole-order-away
  @surface:public
  Rule: One full thing turns the whole order away, and nothing is booked
    An order is taken whole or not at all. When one thing in it loses its last
    place, the whole order is turned away for want of room, and no part of it
    is booked — not even the things that still had room.

    @case:order.a-full-thing-turns-the-order-away
    Scenario: The day-booked thing in an order loses its last place
      Given a Ferry that is booked 1 day at a time, with room for 1 place a day
      And the shop also sells a Mug
      And a customer filled the page selling the Mug and the Ferry in, for a day soon
      When another customer takes 1 Ferry place first
      And the customer sends the form
      Then the customer is told the Ferry no longer has enough room
      And nothing was booked for the customer — no Mug and no Ferry

  @rule:bookings.day-booked-things-must-share-a-day
  @surface:public
  Rule: Day-booked things with no day in common cannot be ordered together
    One order takes one day, so a page selling several day-booked things only
    offers days they are all open on. Two things open on different days leave
    nothing to offer, and the page says so.

    @case:order.no-shared-day-to-order-on
    Scenario: Two things open on different days are offered together
      Given the shop sells a Choir open only on Mondays and a Pilates open only on Tuesdays
      When a customer opens the page selling both together
      Then the customer is told no days are available
      And the page offers no day to pick
