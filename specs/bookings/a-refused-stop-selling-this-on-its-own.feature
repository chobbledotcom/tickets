@story:bookings.a-refused-stop-selling-this-on-its-own
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: An add-on cannot be taken off sale while a choice would be stranded
  An add-on's own page can be the only place a buyer's choice is offered.
  Taking the add-on off sale would leave that choice with no page to be
  bought from, so the site refuses the deactivation and names the choice.

  @rule:bookings.taking-an-add-on-off-sale-is-refused-while-a-choice-leads-only-there
  @surface:admin
  Rule: Taking an add-on off sale is refused while a choice leads only there
    The refusal names the choice that would be stranded, the add-on stays on
    sale with its page, and the choice stays on offer.

    @case:add-ons.taking-the-add-on-off-sale-is-refused
    Scenario: The organiser takes the Cover off sale while its choice is only offered there
      Given a Chair sold with a Cover that can also be bought on its own
      And a buyer's choice called "Gift box" offered on the Cover's own page only
      When the organiser tries to take the Cover off sale
      Then the organiser is told "Gift box" still needs the Cover's page
      And a customer can open the Cover's own page
      And the "Gift box" is still offered when booking the Cover
