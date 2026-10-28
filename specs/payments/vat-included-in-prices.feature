@story:payments.vat-included-in-prices
@owner:payments @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: Included tax comes out of the listed price
  When listed prices include tax, the tax is part of the price the
  customer pays. The site splits the sale: the listing earns the price less
  the tax, and the tax account holds the tax taken out of it.

  @rule:payments.included-vat-comes-out-of-the-listed-price
  @surface:admin @surface:public
  Rule: Included tax comes out of the listed price
    The listing earns the listed price less the tax, the tax account holds the
    tax, and the customer owes nothing beyond the price they paid.

    @case:payment.included-vat-at-the-listed-price
    Scenario: A customer buys a place when its price includes tax
      Given listed prices include 20 percent tax
      When a customer pays for a Concert place listed at 45.00
      Then the Concert place has earned 37.50 and the tax account holds 7.50
      And the customer owes nothing

    @case:payment.included-vat-at-a-fractional-rate
    Scenario: A customer buys a place when its price includes tax at a fractional rate
      Given listed prices include tax at 17.51 percent
      When a customer pays for a Concert place listed at 45.00
      Then the Concert place has earned 38.29 and the tax account holds 6.71
      And the customer owes nothing

  @rule:payments.a-refund-under-included-vat-returns-everything
  @surface:admin
  Rule: A refund under included tax returns everything and clears the tax
    The customer gets back the whole price they paid, the listing earns
    nothing, and the tax account holds nothing. The books still add up.

    @case:payment.refund-of-an-included-vat-booking
    Scenario: The organiser refunds a place bought under included tax
      Given listed prices include 20 percent tax
      And a customer paid 45.00 for a Concert place with tax
      When the organiser refunds the booking
      Then the customer is given back 45.00 once
      And the Concert place and the tax account both hold nothing
      And no money is left unaccounted for
