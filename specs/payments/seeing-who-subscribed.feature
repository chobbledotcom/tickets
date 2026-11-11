@story:payments.seeing-who-subscribed
@owner:payments @risk:medium
@actor:organiser @actor:editor
@edition:managed @edition:self-hosted
Feature: The owner sees who subscribed
  When the Subscriptions feature is on, a Subscriptions menu opens a page.
  The page lists everyone who bought a subscription ticket, with the plan
  their booking keeps and the status that Stripe reported.

  @rule:payments.the-subscriptions-page-lists-every-subscriber
  @surface:admin
  Rule: The Subscriptions page lists every subscriber with their plan
    Each row names the subscriber and the ticket. It shows what Stripe
    charges each period, the tax inside that charge, and the status.

    @case:payments.the-owner-sees-a-new-subscriber
    Scenario: The owner sees a customer who just subscribed
      Given Stripe takes payments for the site
      And the site adds 20 percent tax to listed prices
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every month
      And a customer subscribes with 1 Club ticket
      When the owner opens Subscriptions from the menu
      Then the Subscriptions page lists the customer on the Club ticket
      And the customer's subscription charges "£6 every month" with "£1" of tax
      And the customer's subscription reads "Paid until the first charge"

  @rule:payments.the-subscriptions-menu-follows-the-feature
  @surface:admin
  Rule: The menu offers Subscriptions only while the feature is on
    A site that never sells subscriptions does not show the menu.

    @case:payments.no-subscriptions-menu-while-off
    Scenario: The owner has not turned Subscriptions on
      When the owner looks at the menu
      Then the menu offers no Subscriptions

  @rule:payments.editors-do-not-see-subscribers
  @surface:admin
  Rule: An editor cannot see who subscribed
    The page names customers, so only the owner and managers can open it.

    @case:payments.an-editor-cannot-open-subscriptions
    Scenario: An editor looks for the Subscriptions page
      Given the owner enables "Subscriptions"
      And Eve is signed in as an editor
      Then Eve sees no Subscriptions in the menu and cannot open the page
