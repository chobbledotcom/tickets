@story:payments.sending-a-booking-an-invoice
@owner:payments @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser sends a booking an invoice
  An invoice states what one booking still owes. The site emails the buyer a
  link to read it. A booking has one new invoice at a time. Cancelling the
  invoice frees the booking, and settling the balance the invoice asked for
  closes it.

  @rule:payments.an-invoice-states-what-is-still-owed
  @surface:admin
  Rule: An invoice states what is still owed, and the buyer is sent a link
    The invoice shows the amount the booking still owed on the day the
    organiser made it. The site emails the buyer the link that reads it.

    @case:invoice.states-the-amount-due
    Scenario: The organiser invoices an 80.00 Retreat place
      Given the owner has an email provider of their own
      And a customer owes 80.00 for a Retreat place
      When the organiser sends that booking an invoice
      Then the invoice says 80.00 is due
      And the buyer's email carries a link to the invoice

  @rule:payments.a-booking-has-one-new-invoice
  @surface:admin
  Rule: A booking has one new invoice
    A second invoice waits until the new one is cancelled. The site refuses it
    and says why.

    @case:invoice.a-second-invoice-waits
    Scenario: The organiser tries to invoice the same booking twice
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking an invoice
      When the organiser sends that booking another invoice
      Then the site refuses it because the booking already has a new invoice
      And the booking still has one invoice

    @case:invoice.cancelling-frees-the-booking
    Scenario: The organiser cancels the invoice and sends another one
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking an invoice
      When the organiser cancels the invoice
      And the organiser sends that booking another invoice
      Then the site takes the second invoice as a new one

  @rule:payments.clearing-the-balance-closes-the-invoice
  @surface:admin
  Rule: Clearing the balance closes the new invoice
    When the balance the invoice asked for is settled, the new invoice becomes
    paid.

    @case:invoice.settling-pays-the-invoice
    Scenario: The organiser settles the 80.00 the invoice asked for
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking an invoice
      When the organiser settles the remaining 80.00
      Then the invoice says it is paid

  @rule:payments.a-cancelled-invoices-link-still-opens
  @surface:public
  Rule: A cancelled invoice's link still opens and says so
    The link the buyer was sent keeps working after the organiser cancels the
    invoice. It names the cancelled status and offers no way to pay.

    @case:invoice.cancelled-invoice-link
    Scenario: The buyer opens the link whose invoice was cancelled
      Given the owner has an email provider of their own
      And a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking an invoice
      When the organiser cancels the invoice
      And the buyer opens the link from their email
      Then the invoice says it is cancelled
      And it offers no way to pay
