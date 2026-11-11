@story:payments.cancelling-a-subscription
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The owner cancels a subscription
  The owner can cancel a subscription from the Subscriptions page. Stripe
  stops every later payment at once. The cancel refunds nothing, and the
  booking stays. A booking whose subscription still charges cannot be
  deleted.

  Background:
    Given Stripe takes payments for the site
    And the owner enables "Subscriptions"
    And the organiser sells a Club ticket at 10.00 that charges 5.00 again every month
    And a customer subscribes with 1 Club ticket

  @rule:payments.the-owner-cancels-a-subscription-at-once
  @surface:admin
  Rule: The owner cancels a subscription, and Stripe stops charging at once
    The page then shows that the subscription ended, and offers no second
    cancel.

    @case:payments.the-owner-cancels-a-live-subscription
    Scenario: The owner cancels the customer's subscription
      Given Stripe ends a subscription when the site asks
      When the owner opens Subscriptions from the menu
      And the owner cancels the customer's subscription
      Then the owner is told "Subscription cancelled."
      And the customer's subscription reads "Cancelled"
      And the customer's subscription offers no cancel
      And the Club booking is still there

  @rule:payments.a-live-subscription-keeps-its-booking
  @surface:admin
  Rule: A booking whose subscription still charges cannot be deleted
    The owner cancels the subscription first.

    @case:payments.the-delete-page-refuses-a-live-booking
    Scenario: The owner tries to delete a subscriber
      When the owner opens the delete page of the customer
      Then the owner is told "This booking has a subscription that still charges. Cancel the subscription first."

  @rule:payments.only-the-owner-cancels
  @surface:admin
  Rule: A manager sees subscribers but cannot cancel
    The page names each subscriber, but only the owner can cancel.

    @case:payments.a-manager-sees-no-cancel
    Scenario: A manager opens the Subscriptions page
      Given the owner invited Morgan as a manager
      And Morgan accepted the invitation, chose a password and signed in
      When Morgan opens the Subscriptions page
      Then Morgan sees the customer but no way to cancel
