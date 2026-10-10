@story:catalogue.a-listing-can-require-a-minimum-quantity
@owner:catalogue @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A listing can require a minimum quantity
  An owner who sells in fixed batches — tables of eight, bundles of three —
  sets the smallest number a customer can buy in one purchase. The listing's
  page then offers none, or at least that minimum, and a purchase smaller
  than it buys nothing.

  @rule:catalogue.an-owner-sets-the-minimum
  @surface:admin
  Rule: An owner sets the minimum a customer buys per purchase
    On the listing's own form, the owner fills in "Min tickets per purchase"
    and saves. A minimum larger than the largest quantity the listing allows
    is refused, because nobody could ever buy from it, and the listing keeps
    whatever minimum it had before.

    @case:minimum-quantity.saved-on-the-listing
    Scenario: The owner saves a minimum on a listing
      Given the site sells a Pottery
      When the organiser saves the Pottery with a minimum of 3
      Then the Pottery sells at least 3 per purchase

    @case:minimum-quantity.above-the-maximum-refused
    Scenario: A minimum larger than the maximum is refused
      Given the site sells a Pottery selling at most 2 per purchase
      When the organiser saves the Pottery with a minimum of 3
      Then the organiser is told the minimum must not be more than the maximum
      And the Pottery still sells at least 1 per purchase

  @rule:catalogue.buyers-choose-none-or-at-least-the-minimum
  @surface:public
  Rule: A buyer chooses none, or at least the minimum
    The listing's own booking page offers a choice of none, and then every
    number from the minimum upward. Somebody who sends a smaller number
    anyway is turned away for that reason and leaves nothing behind. When
    fewer places remain than the minimum, nothing small enough can be bought,
    so the listing shows as sold out.

    @case:minimum-quantity.choices-skip-below-the-minimum
    Scenario: The choices offered start at the minimum
      Given the site sells a Pottery selling at least 3 and at most 10 per purchase
      When a visitor opens the Pottery's booking page
      Then the Pottery offers none, or any number from 3 to 10

    @case:minimum-quantity.below-the-minimum-turned-away
    Scenario: A purchase smaller than the minimum buys nothing
      Given the site sells a Pottery selling at least 3 and at most 10 per purchase
      When a buyer tries to book 2 of the Pottery anyway
      Then the buyer is told the Pottery sells at least 3 tickets per booking
      And nobody is booked on the Pottery

    @case:minimum-quantity.fewer-places-left-than-the-minimum
    Scenario: Fewer places left than the minimum shows as sold out
      Given the site sells a Pottery selling at least 3 per purchase with only 2 places left
      When a visitor opens the Pottery's booking page
      Then the Pottery is shown as sold out
      And the Pottery offers no number of tickets to choose
