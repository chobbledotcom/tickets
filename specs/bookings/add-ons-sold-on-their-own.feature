@story:bookings.add-ons-sold-on-their-own
@owner:bookings @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: An add-on that can also be bought on its own
  Some things are only sold alongside something else — a seat cover with a
  chair, a guide with a tour. An organiser can also mark one of those as
  something people may buy on its own. It then gets its own page and its own
  place in the list, and it is still offered with the thing it goes with.

  @rule:bookings.only-an-add-on-marked-for-it-has-its-own-page
  Rule: Only an add-on marked as sellable on its own has a page of its own
    An ordinary add-on has no page a customer could reach. Marking it opens one.

    @case:add-ons.the-marked-one-can-be-opened
    Scenario: A customer opens an add-on that is sold on its own
      Given a Chair sold with a Cover that can also be bought on its own
      Then a customer can open the Cover's own page

    @case:add-ons.an-ordinary-add-on-cannot-be-opened
    Scenario: A customer tries to open an ordinary add-on
      Given a Chair sold with a Strap that is only an add-on
      Then a customer cannot open the Strap's own page

  @rule:bookings.an-add-on-sold-on-its-own-is-listed-like-anything-else
  Rule: An add-on sold on its own is listed like anything else
    It appears in the list of what is for sale with its own booking link, and it
    is not described as an add-on there — because here, it is not one.

    @case:add-ons.it-appears-in-the-list-with-its-own-link
    Scenario: A customer looks at everything for sale
      Given a Chair sold with a Cover that can also be bought on its own
      When a customer looks at everything for sale
      Then the Cover is offered with a link to its own page
      And the Cover is not called an add-on there
      And the Chair is still offered too
      And the Cover is still offered when booking the Chair

  @rule:bookings.the-organiser-can-open-and-close-the-page-again
  @surface:admin
  Rule: The organiser can open and close that page whenever they like
    Marking an ordinary add-on opens its page; unmarking it closes it again.

    @case:add-ons.marking-one-opens-its-page
    Scenario: The organiser starts selling an add-on on its own
      Given a Chair sold with a Strap that is only an add-on
      When the organiser starts selling the Strap on its own
      Then a customer can open the Strap's own page

    @case:add-ons.unmarking-one-closes-its-page
    Scenario: The organiser stops selling an add-on on its own
      Given a Chair sold with a Cover that can also be bought on its own
      When the organiser stops selling the Cover on its own
      Then a customer cannot open the Cover's own page

  @rule:bookings.a-hidden-package-keeps-its-parts-hidden
  Rule: A hidden bundle keeps its parts hidden whatever they are marked
    An organiser can hide what a bundle is made of. Those parts stay hidden even
    when one of them is marked as sellable on its own — the bundle's own choice
    comes first.

    @case:add-ons.a-hidden-bundle-part-stays-hidden
    Scenario: A customer tries to open part of a hidden bundle
      Given a hidden Bundle whose Cushion could be bought on its own
      Then a customer cannot open the Cushion's own page
