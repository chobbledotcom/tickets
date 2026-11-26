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
    While the reviews page is off, the page is not found. The public menu has no
    link to it.

    @case:reviews.off-by-default
    Scenario: A new site has no reviews page
      Given the owner enables "Site"
      When a visitor opens the reviews page
      Then the visitor is told the page is not found
      And the visitor is offered no reviews link

    @case:reviews.enabled
    Scenario: The owner turns reviews on
      Given the owner enables "Site"
      When the owner turns on the reviews page
      And the owner adds a review from "A new reviewer" with the URL "https://example.com/reviews/new"
      And a visitor opens the reviews page
      Then the visitor reads "A new reviewer"
      And the visitor is offered a reviews link

    @case:reviews.disabled
    Scenario: The owner turns reviews off again
      Given the owner enables "Site"
      And the owner turns on the reviews page
      When the owner turns off the reviews page
      And a visitor opens the reviews page
      Then the visitor is told the page is not found
      And the visitor is offered no reviews link

  @rule:settings.the-owner-keeps-the-reviews-list
  @surface:admin
  Rule: The owner keeps the reviews list
    The reviews are records. The owner adds, changes, and removes one review
    at a time, and the public page follows the saved list.

    @case:reviews.adding-a-review
    Scenario: The owner adds a review
      Given the owner enables "Site"
      And the owner turns on the reviews page
      When the owner opens the reviews editor
      And the owner adds a review from "A new reviewer" with the URL "https://example.com/reviews/new"
      And a visitor opens the reviews page
      Then the visitor reads "A new reviewer"
      And the visitor reads "A new review."
