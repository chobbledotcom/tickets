@story:payments.free-and-repeated-money
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: Free bookings and repeated money actions
  A free booking must never invent money, a refund the provider turns down must
  never pretend to have happened, and doing the same thing twice must never
  count it twice. The organiser can also see how the two income figures on a
  listing are worked out.

  @rule:payments.a-free-booking-records-no-money
  @surface:admin
  Rule: A free booking records no money at all
    Even with a booking fee set up, nothing is charged and nothing is recorded.

    @case:payment.free-booking-records-no-money
    Scenario: A customer books a free place while a booking fee is set up
      Given the site adds a 10 percent booking fee
      When a customer books a free Free Meetup place
      Then no money is recorded for the booking
      And no booking fee is recorded

  @rule:payments.a-turned-down-refund-changes-nothing
  @surface:admin
  Rule: A refund the provider turns down changes nothing
    The organiser is told it failed, and the books are exactly as they were.

    @case:payment.declined-refund-changes-nothing
    Scenario: The payment provider turns down the refund
      Given a customer paid 45.00 for a Show place
      When the organiser asks for a refund and the provider turns it down
      Then the organiser is told the refund failed
      And the Show has still earned 45.00 and no money was handed back

  @rule:payments.doing-it-twice-counts-once
  @surface:admin
  Rule: Doing the same thing twice counts it only once
    A repeated payment message makes no second booking, and re-saving the same
    income figure makes no second correction.

    @case:payment.replayed-payment-counts-once
    Scenario: The same payment message arrives again
      Given a customer paid 60.00 for a Repeat place
      When the same payment message arrives again
      Then there is still one booking and one sale

    @case:payment.repeated-correction-counts-once
    Scenario: The organiser saves the same income figure twice
      Given a customer paid 60.00 for a Repeat place
      When the organiser sets the Repeat income to 40.00 twice
      Then the Repeat has earned 40.00 from a single correction

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
