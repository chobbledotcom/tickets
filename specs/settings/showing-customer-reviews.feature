@story:settings.showing-customer-reviews
@owner:settings @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The owner shows customer reviews
  A site can publish a page of customer reviews. The page is off until the
  owner turns it on. While it is off there is no page and no menu link.

  @rule:settings.reviews-are-hidden-until-the-owner-turns-them-on
  @surface:public
  Rule: Reviews are hidden until the owner turns them on
    While the feature is off, the reviews page is not found and the public menu
    has no link to it.

    @case:reviews.off-by-default
    Scenario: A new site has no reviews page
      Given the owner enables "Site"
      When a visitor opens the reviews page
      Then the visitor is told the page is not found
      And the visitor is offered no reviews link

    @case:reviews.enabled
    Scenario: The owner turns reviews on
      Given the owner enables "Site"
      When the owner enables "Reviews"
      And a visitor opens the reviews page
      Then the visitor reads "Sample customer"
      And the visitor reads "This is a sample review."
      And the visitor is offered a reviews link

    @case:reviews.disabled
    Scenario: The owner turns reviews off again
      Given the owner enables "Site"
      And the owner enables "Reviews"
      When the owner disables "Reviews"
      And a visitor opens the reviews page
      Then the visitor is told the page is not found
      And the visitor is offered no reviews link

  @rule:settings.the-owner-edits-the-reviews-file
  @surface:admin
  Rule: The owner edits the reviews file
    The reviews editor holds the whole markdown file. A save the parser cannot
    read is refused, and the saved file stays.

    @case:reviews.adding-a-review
    Scenario: The owner adds a review
      Given the owner enables "Site"
      And the owner enables "Reviews"
      When the owner opens the reviews editor
      And the owner replaces the reviews file with a review from "A new reviewer"
      And a visitor opens the reviews page
      Then the visitor reads "A new reviewer"
      And the visitor reads "A new review."
