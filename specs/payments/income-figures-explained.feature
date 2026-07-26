@story:payments.income-figures-explained
@owner:payments @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser can see how a listing's income adds up
  A listing shows two income figures. The page must explain, line by line, how
  each one is worked out, so they can never quietly disagree.

  @rule:payments.the-income-figures-are-explained
  @surface:admin
  Rule: The listing page explains how its income figures are worked out
    Sales, corrections and refunds are each listed with their own sign, so the
    two income figures can never quietly disagree.

    @case:payment.income-breakdown-explains-the-figures
    Scenario: The organiser reads the money breakdown after a correction and a refund
      Given a customer paid 50.00 for a Reconciled place
      And the organiser corrected the Reconciled income to 40.00
      When the organiser refunds the booking
      Then the Reconciled page breaks the money down line by line
      And the breakdown links to the Reconciled money record
