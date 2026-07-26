@story:payments.one-payment-many-listings
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: One payment can cover places on several listings
  A customer buying places on more than one listing pays once. Each listing must
  earn only its own part of that payment.

  @rule:payments.one-payment-pays-each-listing-its-share
  @surface:admin
  Rule: One payment covering two listings pays each its own share
    A customer buying places on two listings at once pays once, and each
    listing earns only its own part.

    @case:payment.one-payment-two-listings
    Scenario: A customer pays once for a place on each of two listings
      Given Part One costs 30.00 and Part Two costs 20.00
      When a customer pays 50.00 for one place on each
      Then Part One has earned 30.00 and Part Two has earned 20.00
      And both places belong to the same order
      And each listing's page shows its own earnings
