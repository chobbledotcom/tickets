@story:payments.vat-added-to-prices
@owner:payments @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: Added VAT sits on top of the listed price
  When a site adds value added tax to its listed prices, a sale keeps the whole
  listed price as ticket income and records the tax on top of it. The customer
  pays the tax-inclusive total, and a refund hands the whole total back and
  clears the tax account.

  @rule:payments.added-vat-sits-on-top-of-the-listed-price
  @surface:admin @surface:public
  Rule: Added VAT sits on top of the listed price
    The listing earns its listed price, the tax account holds the added tax,
    and the customer owes nothing beyond the total they paid.

    @case:payment.added-vat-at-the-listed-price
    Scenario: A customer buys a place when the site adds tax
      Given the site adds 20 percent value added tax to listed prices
      When a customer pays for a Concert place listed at 45.00
      Then the Concert place has earned 45.00 and the VAT account holds 9.00
      And the customer owes nothing

    @case:payment.added-vat-at-zero-rate
    Scenario: A customer buys a place when the site adds zero tax
      Given the site adds 0 percent value added tax to listed prices
      When a customer pays for a Concert place listed at 45.00
      Then the Concert place has earned 45.00
      And no value added tax was recorded or refunded
      And the customer owes nothing

  @rule:payments.a-refund-under-added-vat-returns-everything
  @surface:admin
  Rule: A refund under added VAT returns everything and clears the tax
    The customer gets back the whole tax-inclusive total, the listing earns
    nothing, and the tax account holds nothing. The books still add up.

    @case:payment.refund-of-an-added-vat-booking
    Scenario: The organiser refunds a place bought under added tax
      Given the site adds 20 percent value added tax to listed prices
      And a customer paid 45.00 for a Concert place with value added tax
      When the organiser refunds the booking
      Then the customer is given back 54.00 once
      And the Concert place and the VAT account both hold nothing
      And no money is left unaccounted for
