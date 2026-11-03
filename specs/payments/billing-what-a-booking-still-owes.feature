@story:payments.billing-what-a-booking-still-owes
@owner:payments @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: An organiser bills a booking what it still owes
  An invoice is a bill for one booking. The organiser issues it, and the site
  emails the buyer a link to read it. A booking has one open bill at a time.
  Cancelling the bill frees the booking, and settling the balance the bill
  asked for closes it.

  @rule:payments.a-bill-states-what-is-still-owed
  @surface:admin
  Rule: A bill states what is still owed, and the buyer is sent a link
    The bill shows the amount the booking still owed on the day the organiser
    issued it. The site emails the buyer the link that reads it.

    @case:billing.bill-states-the-amount-due
    Scenario: The organiser bills an 80.00 Retreat place
      Given the owner has an email provider of their own
      And a customer owes 80.00 for a Retreat place
      When the organiser sends that booking a bill
      Then the bill says 80.00 is due
      And the buyer's email carries a link to the bill

  @rule:payments.a-booking-has-one-open-bill
  @surface:admin
  Rule: A booking has one open bill
    A second bill waits until the open one is cancelled. The site refuses it
    and says why.

    @case:billing.a-second-bill-waits
    Scenario: The organiser tries to bill the same booking twice
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking a bill
      When the organiser sends that booking another bill
      Then the site refuses it because the booking already has a new bill
      And the booking still has one bill

    @case:billing.cancelling-frees-the-booking
    Scenario: The organiser cancels the bill and issues another one
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking a bill
      When the organiser cancels the bill
      And the organiser sends that booking another bill
      Then the site takes the second bill as a new one

  @rule:payments.clearing-the-balance-closes-the-bill
  @surface:admin
  Rule: Clearing the balance closes the open bill
    When the balance the bill asked for is settled, the open bill becomes paid.

    @case:billing.settling-pays-the-bill
    Scenario: The organiser settles the 80.00 the bill asked for
      Given a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking a bill
      When the organiser settles the remaining 80.00
      Then the bill says it is paid

  @rule:payments.a-cancelled-bills-link-still-opens
  @surface:public
  Rule: A cancelled bill's link still opens and says so
    The link the buyer was sent keeps working after the organiser cancels the
    bill. It names the cancelled status and offers no way to pay.

    @case:billing.cancelled-bill-link
    Scenario: The buyer opens the link whose bill was cancelled
      Given the owner has an email provider of their own
      And a customer owes 80.00 for a Retreat place
      And the organiser has sent that booking a bill
      When the organiser cancels the bill
      And the buyer opens the link from their email
      Then the bill says it is cancelled
      And it offers no way to pay
