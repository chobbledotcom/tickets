@story:payments.correcting-the-books
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser corrects the books
  Sometimes the figures need putting right: a listing earned less than it looks,
  someone owes a different amount, or an extra charge took more than recorded.
  An organiser can correct any of these — and none of it moves real money. Cash
  reports must stay honest, so every correction is parked as a write-off rather
  than pretending money came in or went out.

  @rule:payments.correcting-a-listing-income-never-moves-cash
  @surface:admin
  Rule: Correcting what a listing earned never moves cash
    The listing's earnings change by exactly the difference, in one correction,
    and the money the site actually holds is untouched.

    @case:correction.listing-income-written-down
    Scenario: The organiser writes a Gala's earnings down from 50.00 to 20.00
      Given a customer paid 50.00 for a Gala place
      When the organiser corrects the Gala listing's income to 20.00
      Then the Gala listing has earned 20.00
      And the 30.00 difference was written off in one correction
      And the money the site holds is unchanged
      And every page shows the Gala earning 20.00

  @rule:payments.a-refund-after-a-correction-leaves-the-correction-standing
  @surface:admin
  Rule: A refund after a correction leaves the correction standing
    Refunding gives back what the customer paid. It does not undo the
    organiser's correction, so the two figures the organiser reads mean
    different things — and both are right.

    @case:correction.refund-after-a-write-down
    Scenario: The organiser refunds a booking whose listing was written down
      Given a customer paid 50.00 for a Gala place
      And the organiser corrected the Gala listing's income to 20.00
      When the organiser refunds the booking
      Then the customer has the whole 50.00 back and owes nothing
      And the money record shows the write-off still standing at -30.00
      And the listing page still shows 20.00 earned
      And no money is left unaccounted for

  @rule:payments.correcting-what-someone-owes-never-moves-cash
  @surface:admin
  Rule: Correcting what someone owes never moves cash
    An organiser can lower what someone owes as a goodwill gesture, or raise it
    with a charge. Either way the listing's earnings and the site's cash are
    untouched.

    @case:correction.what-someone-owes-moves-both-ways
    Scenario: The organiser lowers then raises what someone owes
      Given a customer owes 60.00 for a Series place
      When the organiser lets them off 35.00
      Then they owe 25.00, on the books and on their money page
      When the organiser charges them 15.00 more
      Then they owe 40.00, on the books and on their money page
      And the Series has still earned 60.00, and the money the site holds is unchanged

  @rule:payments.correcting-an-extra-charge-never-moves-cash
  @surface:admin
  Rule: Correcting what an extra charge earned never moves cash
    The charge's earnings move to the figure the organiser typed, in one
    correction, and every page showing it agrees.

    @case:correction.extra-charge-earnings
    Scenario: The organiser corrects a VIP Surcharge from 7.00 to 12.00
      Given a VIP Surcharge that has earned 7.00
      When the organiser corrects the surcharge's income to 12.00
      Then the surcharge's earnings are now 12.00
      And the 5.00 difference came from the write-off in one correction
      And the money the site holds is unchanged
      And every page shows the surcharge's earnings as 12.00
