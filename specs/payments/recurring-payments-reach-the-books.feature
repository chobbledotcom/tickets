@story:payments.recurring-payments-reach-the-books
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: Recurring payments reach the books
  Stripe charges each subscriber again every period. Scheduled maintenance
  asks Stripe what it took, and records each payment with its tax on the
  day Stripe took it. The Subscriptions page shows the status that Stripe
  reported.

  @rule:payments.each-renewal-is-recorded-on-its-day
  @surface:admin
  Rule: Each recurring payment is recorded with its tax on the day Stripe took it
    The listing earns the payment less its tax. The tax account holds the
    tax.

    @case:payments.a-monthly-renewal-with-added-tax
    Scenario: Stripe takes the first monthly charge
      Given Stripe takes payments for the site
      And the site adds 20 percent tax to listed prices
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every month
      And a customer subscribes with 1 Club ticket
      And Stripe took a renewal of 6.00 on 2026-03-01
      When scheduled maintenance runs
      Then the Club place has earned 15.00 and the tax account holds 3.00
      And the Club booking paid 6.00 on 2026-03-01
      When the owner opens Subscriptions from the menu
      Then the customer's subscription reads "Active"

  @rule:payments.an-ended-subscription-keeps-its-last-payment
  @surface:admin
  Rule: A subscription that ended still records the payments Stripe took
    The last payment reaches the books, and the page shows that the
    subscription ended.

    @case:payments.the-last-renewal-before-an-end
    Scenario: Stripe ends the subscription after one more charge
      Given Stripe takes payments for the site
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every month
      And a customer subscribes with 1 Club ticket
      And Stripe took a last renewal of 5.00 on 2026-03-01, then ended the subscription
      When scheduled maintenance runs
      Then the Club place has earned 15.00
      And the Club booking paid 5.00 on 2026-03-01
      When the owner opens Subscriptions from the menu
      Then the customer's subscription reads "Cancelled"
