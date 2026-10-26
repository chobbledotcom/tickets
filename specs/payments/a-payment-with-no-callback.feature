@story:payments.a-payment-with-no-callback
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A payment whose callback was lost
  SumUp can take a customer's money while the one callback that would have
  booked it never reaches the site, and the customer gives up before the
  payment page answers. The site has the checkout written down, so its
  scheduled maintenance can ask SumUp about it, book the payment, and leave
  the customer a payment link that still works.

  @rule:payments.a-lost-callback-is-recovered-by-scheduled-maintenance
  @surface:public
  Rule: Maintenance books a paid checkout whose callback never arrived
    Until maintenance asks, the booking does not exist. Once it has asked,
    the booking is there exactly once, and the payment link the customer was
    given still reaches their success page.

    @case:payments.maintenance-books-the-lost-payment
    Scenario: The callback never arrives and the customer never comes back
      Given Alice pays for a 45.00 Concert place through SumUp on the public booking page
      And the customer did pay SumUp
      And the site never hears that the payment arrived
      When scheduled maintenance runs
      Then the payment is booked
      When the customer opens the payment link they were given
      Then they reach the page that says their payment was successful
      And the payment is still booked exactly once
