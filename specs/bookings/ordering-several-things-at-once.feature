@story:bookings.ordering-several-things-at-once
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer orders several things at once
  An organiser can sell things in bundles, as add-ons to something bigger, on
  their own, and by the day. A customer can put all of those in one order — and
  can order the same thing more than one way. Each way must be kept as its own
  booking, so the organiser can see what was ordered and how.

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
