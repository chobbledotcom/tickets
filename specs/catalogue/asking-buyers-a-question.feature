@story:catalogue.asking-buyers-a-question
@owner:catalogue @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner decides what buyers are asked
  Booking can ask the buyer a question — a choice between answers the owner
  wrote, or a box for the buyer's own words. The owner decides which listings
  ask it, reads what each buyer said, and can take a question away again by
  typing its text to confirm.

  @rule:catalogue.a-question-is-asked-only-where-it-is-assigned
  @surface:public
  Rule: A question is asked only where the owner assigned it
    Assigning a question to one listing does not put it on the others. A buyer
    booking anything else is not asked.

    @case:buyer-questions.asked-on-the-assigned-listing-only
    Scenario: Two listings, one question
      Given the site sells a Pottery
      And the site sells a Kiln
      And the owner asks Pottery buyers "Collection day?" offering Saturday or Sunday
      Then a visitor booking the Pottery is offered "Collection day?" with Saturday and Sunday
      And a visitor booking the Kiln is not asked "Collection day?"

  @rule:catalogue.a-buyers-own-words-reach-the-owner
  @surface:public
  Rule: A buyer's own words reach the owner
    A written question has no answers to offer — the buyer types whatever they
    like, and the owner reads it back against that booking. Because there is
    nothing to choose from, the site refuses to add answer choices to one.

    @case:buyer-questions.a-typed-answer-is-kept
    Scenario: A buyer writes their own answer
      Given the site sells a Pottery
      And the owner asks Pottery buyers to write "Anything we should know?"
      When a visitor books the Pottery answering "I will arrive late"
      Then the owner reads "I will arrive late" against that booking

    @case:buyer-questions.a-written-question-offers-no-choices
    Scenario: A written question's page offers no choices to manage
      Given the owner asks buyers to write "Anything we should know?"
      Then the owner is offered no way to add answer choices

  @rule:catalogue.taking-a-question-away-needs-its-exact-text
  Rule: Taking a question away needs its exact text
    Deleting a question is deliberate: the owner types the question's text to
    confirm. Text that does not match changes nothing, and buyers go on being
    asked. Once it matches, the question is gone and buyers are not asked
    again.

    @case:buyer-questions.wrong-text-changes-nothing
    Scenario: The owner types the wrong text
      Given the site sells a Pottery
      And the owner asks Pottery buyers "Collection day?" offering Saturday or Sunday
      When the owner takes the question away, typing "Collection date?"
      Then the owner is told the question's text does not match
      And a visitor booking the Pottery is offered "Collection day?" with Saturday and Sunday

    @case:buyer-questions.gone-once-the-text-matches
    Scenario: The owner types the exact text
      Given the site sells a Pottery
      And the owner asks Pottery buyers "Collection day?" offering Saturday or Sunday
      When the owner takes the question away, typing "Collection day?"
      Then the owner is told the question is deleted
      And a visitor booking the Pottery is not asked "Collection day?"
