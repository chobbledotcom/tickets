@story:payments.booking-with-a-discount-code
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:public
Feature: A customer books with a discount code
  The organiser hands out a code, and a customer who types it at checkout
  pays less. The listing's own price never changes — the discount shows as
  its own line, and only the total comes down. A code is worth nothing to
  anyone who does not have it.

  @rule:payments.the-code-box-waits-for-a-code-to-exist
  Rule: The code box waits for a code to exist
    Until the organiser has made a promo code, the booking page asks for no
    code at all. Creating one is confirmed, and the box appears.

    @case:discount-codes.no-codes-no-box
    Scenario: Nobody has made a code yet
      Given the site sells places at the Pottery for 10.00
      Then the Pottery booking page offers no promo code box

    @case:discount-codes.the-first-code-brings-the-box
    Scenario: The organiser makes the first code
      Given the site sells places at the Pottery for 10.00
      When the organiser creates a promo code "SAVE10" taking 10 percent off
      Then the organiser is told the modifier was created
      And the Pottery booking page offers a promo code box

  @rule:payments.the-right-code-cuts-only-the-total
  Rule: The right code cuts the total, not the listing's price
    The price summary keeps the place at its full price and shows the
    discount as its own line, so the customer can see exactly what the code
    was worth. Typing the code in the wrong case costs nothing — the code is
    matched however it is typed.

    @case:discount-codes.the-code-cuts-the-total
    Scenario: A customer types the code
      Given the site sells places at the Pottery for 10.00
      And the organiser has a promo code "SAVE10" taking 10 percent off
      When a customer asks the price of a Pottery place with the code "SAVE10"
      Then the summary shows the place at 10.00
      And the summary shows the discount line "SAVE10" taking off 1.00
      And the summary total is 9.00

    @case:discount-codes.the-code-works-in-any-case
    Scenario: A customer types the code in lowercase
      Given the site sells places at the Pottery for 10.00
      And the organiser has a promo code "SAVE10" taking 10 percent off
      When a customer asks the price of a Pottery place with the code "save10"
      Then the summary total is 9.00

  @rule:payments.a-wrong-code-quietly-buys-nothing
  Rule: A wrong code quietly buys nothing
    A code that matches nothing is simply ignored: no discount line appears
    and the total stays at the full price. The site says nothing about it,
    so a guessed code gives nothing away.

    @case:discount-codes.a-wrong-code-changes-nothing
    Scenario: A customer guesses at a code
      Given the site sells places at the Pottery for 10.00
      And the organiser has a promo code "SAVE10" taking 10 percent off
      When a customer asks the price of a Pottery place with the code "TENOFF"
      Then the summary total is 10.00
      And the summary shows no discount line
      And the summary never names "TENOFF"
      And the summary reads exactly as it does for a Pottery place with no code

  @rule:payments.the-books-remember-what-a-code-was-used-for
  @surface:webhook
  Rule: The books remember what a code was used for
    When a customer pays with a code, the site counts that use and writes
    what the code was worth into the activity log, so the organiser can see
    what their codes are costing them.

    @case:discount-codes.a-paid-booking-counts-the-use
    Scenario: A customer pays with the code
      Given the site sells places at the Pottery for 10.00
      And the organiser has a promo code "SAVE10" taking 10 percent off
      When a customer books a Pottery place with the code "SAVE10" and pays
      Then the code "SAVE10" has been used once, worth 1.00
      And the activity log says the code "SAVE10" took 1.00 off
