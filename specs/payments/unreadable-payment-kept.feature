@story:payments.unreadable-payment-kept
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A payment the site cannot read is kept and refunded
  A provider can report a paid checkout in a form the site cannot read.
  The money was really taken, so it goes back, the customer is kept as a
  booking with no ticket, and the books say what happened.

  @rule:payments.unreadable-money-goes-back-once
  @surface:webhook
  Rule: An unreadable paid checkout is kept and its money goes back
    The customer is kept, the money returns exactly once, and the
    organiser can see the payment, its return, and the reason.

    @case:unreadable-payment.kept-and-refunded
    Scenario: The provider reports a paid checkout the site cannot read
      Given a paid checkout arrives in a form the site cannot read
      When the payment message is delivered
      Then the message is answered as settled without a ticket
      And the customer is kept as a booking with no ticket
      And the money is handed back exactly once
      And the organiser can read why the payment was returned
      And the books show the payment and its return in balance
      And no returned payment is waiting in refund recovery

  @rule:payments.unreadable-message-replays-clean
  @surface:webhook
  Rule: The same payment message arriving again changes nothing
    Providers deliver the same message more than once. A repeat must
    not add a booking, a refund, a note, or a money entry.

    @case:unreadable-payment.replay-changes-nothing
    Scenario: The same unreadable payment message is delivered again
      Given a paid checkout arrives in a form the site cannot read
      And the payment message is delivered
      When the same payment message is delivered again
      Then the message is answered as settled without a ticket
      And the customer is kept as a booking with no ticket
      And the money is handed back exactly once
      And the organiser can read why the payment was returned
      And the books show the payment and its return in balance

  @rule:payments.unreadable-money-catches-up
  @surface:webhook
  Rule: Money finishes catching up after a temporary failure
    The refund can go back while the money records fail to save. The
    failed delivery is retried by the provider, and the retry finishes
    the records without sending any more money.

    @case:unreadable-payment.money-catches-up
    Scenario: The money records fail once and the retry completes them
      Given a paid checkout arrives in a form the site cannot read
      And the money records are temporarily failing to save
      And the payment message fails on delivery
      When the money records recover and the message is delivered again
      Then the message is answered as settled without a ticket
      And the customer is kept as a booking with no ticket
      And the money is handed back exactly once
      And the organiser can read why the payment was returned
      And the books show the payment and its return in balance
