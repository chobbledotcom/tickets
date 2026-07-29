@story:payments.paying-a-deposit
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A customer pays a deposit and settles the rest later
  Someone can pay part of what they owe now and the rest later. Until they
  settle, the organiser must be able to see exactly what is still outstanding.

  @rule:payments.a-deposit-leaves-the-rest-owing-until-it-is-settled
  @surface:admin
  Rule: A deposit leaves the rest owing until it is settled
    The amount still to pay is the same on the books and on the page the
    organiser reads, and settling it clears both.

    @case:deposit.owed-until-settled
    Scenario: A customer pays 30.00 of an 80.00 Retreat place
      Given a customer owes 80.00 for a Retreat place
      When they pay a deposit of 30.00
      Then they still owe 50.00, on the books and on their money page
      When the organiser settles the remaining 50.00
      Then they owe nothing, and their money page says the booking is fully paid

  @rule:payments.the-customer-can-see-what-is-left
  @surface:public
  Rule: The customer can see what is left
    A reserved booking has a payment link the customer can open without
    signing in. It names what they booked, what they have paid and what is
    left, and offers to take the rest. It carries no personal details.

    What happens after the offer is taken is a payment provider's business
    and is not read here.

    @case:deposit.balance-page-shows-what-is-left
    Scenario: The payment link for a part-paid 80.00 Retreat place
      Given a customer owes 80.00 for a Retreat place
      When they pay a deposit of 30.00
      Then their payment link offers to take the 50.00 that is left
      And it names the Retreat place, 80.00 ordered and 30.00 paid
      And it says nothing about who booked
