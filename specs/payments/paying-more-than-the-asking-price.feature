@story:payments.paying-more-than-the-asking-price
@owner:payments @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer chooses to pay more than the asking price
  Some listings let a customer pay more than the price asked. What the listing
  earns must be what they actually chose to pay, not the asking price.

  @rule:payments.the-listing-earns-what-the-customer-chose
  @surface:admin
  Rule: The listing earns exactly what the customer chose to pay
    Every place the organiser reads that figure shows the same amount, and the
    customer owes nothing afterwards.

    @case:pay-more.the-chosen-price-is-the-income
    Scenario: A customer pays 80.00 for a place asking 30.00
      Given a Donate listing that asks 30.00 and lets people pay more
      When a customer chooses to pay 80.00
      Then the Donate has earned 80.00
      And the customer owes nothing
      And the organiser sees 80.00 wherever the income is shown
