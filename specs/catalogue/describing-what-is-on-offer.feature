@story:catalogue.describing-what-is-on-offer
@owner:catalogue @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner describes what is on offer
  An owner keeps a list of details worth stating about the things they sell —
  accessibility, parking, what to bring — each with the wordings it can take.
  Marking a listing with one shows it to everyone reading that listing's page.
  A detail can be removed again by typing its name to confirm.

  @rule:catalogue.a-marked-detail-is-shown-to-visitors
  @surface:public
  Rule: A detail marked on a listing is shown to its visitors
    The listing's page states the detail and the wording the owner picked, and
    only that wording. A wording the owner did not pick stays off the page.

    @case:listing-details.picked-wording-shown
    Scenario: The owner marks a listing as step-free
      Given the site sells a Pottery
      And the owner keeps a detail called Accessibility worded "Step-free" or "Stairs only"
      When the owner marks the Pottery as "Step-free"
      Then a visitor reading the Pottery page sees Accessibility stated as "Step-free"
      And a visitor reading the Pottery page is not told "Stairs only"

  @rule:catalogue.removing-a-detail-needs-its-exact-name
  Rule: Removing a detail needs its exact name
    Deleting a detail is deliberate: the owner types the detail's name to
    confirm. A name that does not match changes nothing, and the listing's
    page keeps stating it. Once it matches, the detail is gone from every
    listing that carried it.

    @case:listing-details.wrong-name-changes-nothing
    Scenario: The owner types the wrong name
      Given the site sells a Pottery
      And the owner keeps a detail called Accessibility worded "Step-free" or "Stairs only"
      And the owner marks the Pottery as "Step-free"
      When the owner removes the detail Accessibility, typing "Accessible"
      Then the owner is told the detail's name does not match
      And a visitor reading the Pottery page sees Accessibility stated as "Step-free"

    @case:listing-details.gone-once-the-name-matches
    Scenario: The owner types the exact name
      Given the site sells a Pottery
      And the owner keeps a detail called Accessibility worded "Step-free" or "Stairs only"
      And the owner marks the Pottery as "Step-free"
      When the owner removes the detail Accessibility, typing "Accessibility"
      Then the owner is told the detail is deleted
      And a visitor reading the Pottery page is not told "Accessibility"
