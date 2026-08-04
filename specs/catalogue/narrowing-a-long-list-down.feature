@story:catalogue.narrowing-a-long-list-down
@owner:catalogue @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The organiser narrows a long list down to what they are looking for
  An organiser with plenty for sale can narrow their own list to one kind of
  thing, or to the things marked with one wording of a detail, and the two
  narrowings hold together. Customers are never narrowed: the list they read
  shows everything the site sells.

  @rule:catalogue.the-list-narrows-to-one-kind-of-thing
  @surface:admin
  Rule: The organiser's list narrows to one kind of thing
    The choice is only offered when there is more than one kind to choose
    between, and taking it leaves only that kind on the list.

    @case:listing-filter.narrowing-to-one-kind
    Scenario: The organiser looks only at what is sold by the day
      Given the site sells places at the Pottery
      And the site sells day places at the Boat
      When the organiser narrows the list to "Daily"
      Then the list offers the Boat
      And the list does not offer the Pottery

    @case:listing-filter.nothing-to-narrow-between
    Scenario: Everything on sale is the same kind
      Given the site sells places at the Pottery
      And the site sells places at the Quiz
      When the organiser opens their list
      Then the organiser is offered no way to narrow the list by kind

  @rule:catalogue.the-list-narrows-to-one-wording
  @surface:admin
  Rule: The organiser's list narrows to one wording of a detail
    A detail the owner states about what they sell — how hard it is, where it
    is — becomes a way to narrow the list, and it holds alongside the kind.

    @case:listing-filter.narrowing-to-one-wording
    Scenario: The organiser looks only at the easy ones
      Given the site sells places at the Pottery
      And the site sells places at the Quiz
      And the owner keeps a detail called Difficulty worded "Easy" or "Hard"
      And the owner marks the Pottery as "Easy"
      And the owner marks the Quiz as "Hard"
      When the organiser narrows the list to "Easy"
      Then the list offers the Pottery
      And the list does not offer the Quiz

    @case:listing-filter.both-narrowings-at-once
    Scenario: The organiser narrows by kind and by wording at once
      Given the site sells places at the Pottery
      And the site sells day places at the Boat
      And the site sells day places at the Kayak
      And the owner keeps a detail called Difficulty worded "Easy" or "Hard"
      And the owner marks the Pottery as "Easy"
      And the owner marks the Boat as "Easy"
      And the owner marks the Kayak as "Hard"
      When the organiser narrows the list to "Easy"
      And the organiser narrows the list to "Daily"
      Then the list offers the Boat
      And the list does not offer the Pottery
      And the list does not offer the Kayak

  @rule:catalogue.customers-are-never-narrowed
  @surface:public
  Rule: The list customers read is never narrowed
    Everything on sale is offered together, whatever kind each thing is, and a
    customer is never asked to choose between kinds.

    @case:listing-filter.customers-are-shown-everything
    Scenario: A customer looks at everything on sale
      Given the public site is on
      And the site sells places at the Pottery
      And the site sells day places at the Boat
      When a customer looks at everything on sale
      Then the customer is shown both the Pottery and the Boat
      And the customer is offered no way to narrow the list by kind
