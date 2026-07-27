@story:bookings.selling-things-as-one-bundle
@owner:bookings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser sells several things as one bundle
  An organiser can take a group of things they sell and offer the whole group as
  one bundle: a tent, a pitch and a breakfast sold together as a weekend. The
  bundle sets its own price for each part, so a thing can cost less inside
  the bundle than on its own. The organiser can also keep what is inside
  private, and sell the bundle purely by its own name.

  @rule:bookings.a-bundle-sets-its-own-price-for-each-part
  @surface:admin
  Rule: A bundle sets its own price for each part
    The organiser sets a price against each thing in the bundle, and that is
    what the bundle keeps. A price left blank is not a price of zero: the
    bundle keeps none of its own for that thing, and the thing's own price
    stands.

    @case:bundles.pricing-each-part
    Scenario: The organiser prices the things inside a bundle
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      When the organiser sells the Weekend as a bundle, with the Tent at 25.00 and the Breakfast left blank
      Then the Weekend is sold as one bundle
      And the bundle charges 25.00 for the Tent
      And the bundle sets no price of its own for the Breakfast

  @rule:bookings.a-bundle-can-keep-what-is-inside-it-private
  Rule: A bundle can keep what is inside it private
    The organiser can sell a bundle by its own name alone. A customer buying it
    is never shown the names of the things inside, on the booking page or on the
    ticket they end up holding.

    @case:bundles.the-parts-are-never-named
    Scenario: A customer buys a bundle whose contents are private
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a private bundle
      When a customer buys the Weekend
      Then the booking page never named the Tent
      And the booking page never named the Breakfast
      And their ticket names the Weekend
      And their ticket never names the Tent
      And their ticket never names the Breakfast

  @rule:bookings.a-private-bundle-that-has-sold-cannot-be-pulled-apart
  @surface:admin
  Rule: A private bundle that has sold cannot be pulled apart
    Deleting a private bundle, or turning it back into an ordinary group, would
    make the tickets already sold fall back to naming the things inside. So
    while anyone holds such a ticket, the site refuses both until the organiser
    has made what is inside public again — which is their decision to take, in
    the open.

    @case:bundles.deleting-a-sold-private-bundle-is-refused
    Scenario: The organiser tries to delete a private bundle someone has bought
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a private bundle
      And a customer buys the Weekend
      When the organiser tries to delete the Weekend
      Then the organiser is told to make its contents public first
      And the Weekend is still there
      And their ticket names the Weekend
      And their ticket never names the Tent
      And their ticket never names the Breakfast

    @case:bundles.unbundling-a-sold-private-bundle-is-refused
    Scenario: The organiser tries to stop bundling a private bundle someone has bought
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a private bundle
      And a customer buys the Weekend
      When the organiser stops selling the Weekend as a bundle
      Then the organiser is told to make its contents public first
      And the Weekend is still sold as one bundle
      And their ticket names the Weekend
      And their ticket never names the Tent
      And their ticket never names the Breakfast

    @case:bundles.unbundling-is-allowed-once-the-parts-are-public
    Scenario: The organiser makes the contents public and then stops bundling
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a private bundle
      And a customer buys the Weekend
      When the organiser lets people see what is inside the Weekend
      And the organiser stops selling the Weekend as a bundle
      Then the Weekend is no longer sold as one bundle
      And their ticket names the Tent
      And their ticket names the Breakfast

    @case:bundles.deleting-is-allowed-once-the-parts-are-public
    Scenario: The organiser makes the contents public and then deletes the bundle
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a private bundle
      And a customer buys the Weekend
      When the organiser lets people see what is inside the Weekend
      And the organiser tries to delete the Weekend
      Then the Weekend is gone
      And the Tent is still for sale on its own
      And the Breakfast is still for sale on its own
      And their ticket names the Tent
      And their ticket names the Breakfast

  @rule:bookings.an-open-bundle-can-always-be-pulled-apart
  @surface:admin
  Rule: An open bundle can always be pulled apart
    A bundle that never hid anything has nothing to give away, so the organiser
    can stop bundling it whenever they like, even after people have bought it.

    @case:bundles.unbundling-a-sold-open-bundle
    Scenario: The organiser stops bundling something people have already bought
      Given a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a bundle, with the Tent at 25.00 and the Breakfast left blank
      And a customer buys the Weekend
      When the organiser stops selling the Weekend as a bundle
      Then the Weekend is no longer sold as one bundle
      And their ticket names the Tent
      And their ticket names the Breakfast
