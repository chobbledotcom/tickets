@story:attendees.removing-one-part-of-an-order
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser removes one part of an order
  A customer's order can hold the same thing more than once — inside a bundle
  and on its own. An organiser must be able to take away one of those without
  disturbing the other.

  @rule:attendees.removing-one-part-leaves-the-rest
  @surface:admin
  Rule: Setting one part of an order to no places leaves the other parts alone
    The part the organiser emptied is gone; everything else in the order stays
    exactly as it was booked.

    @case:order-edit.one-path-removed
    Scenario: The organiser removes the item that was ordered on its own
      Given a customer ordered a Duo Kit and a Drum on its own
      When the organiser sets the on-its-own Drum to no places
      Then only the Drum inside the Duo Kit is left
