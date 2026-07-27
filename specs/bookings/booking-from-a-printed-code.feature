@story:bookings.booking-from-a-printed-code
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer books from a code the organiser printed
  The organiser can make a booking code for something they sell and put it on a
  poster, a table card, or a flyer. Whoever reads it goes straight to booking
  that one thing, with everything the organiser already filled in ready for
  them. The code is signed, so nothing carried in it can be changed on the way.

  @rule:bookings.a-code-that-says-everything-goes-straight-to-paying
  Rule: A code that says everything sends the customer straight to paying
    If the organiser filled in who it is for and what it costs, there is nothing
    left to ask, so the customer goes straight to paying that amount.

    @case:printed-code.straight-to-paying
    Scenario: A customer reads a code with nothing left to fill in
      Given a Workshop is on sale at 5.00
      When the organiser makes a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer reads that code
      Then the customer is sent straight off to pay
      And they are asked for 12.00
      And it is for 1 place
      And the booking is in the name "Ada Lovelace"

  @rule:bookings.the-price-on-the-code-is-what-they-pay
  Rule: The price on the code is what the customer pays
    The organiser can put a one-off price on a code — an offer, a door price, a
    deal — and that is what is charged, not the listing's usual price.

    @case:printed-code.the-codes-price-wins
    Scenario: A code carries a price of its own
      Given a Workshop is on sale at 5.00
      When the organiser makes a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer reads that code
      Then they are asked for 12.00

    @case:printed-code.paying-more-still-wins
    Scenario: A customer chooses to pay more than the code says
      Given a Workshop is on sale at 5.00, and people may pay more
      When the organiser makes a code for the Workshop at 12.00
      And a customer reads that code
      And the customer decides to pay 20.00 instead
      Then they are asked for 20.00

  @rule:bookings.a-code-that-leaves-something-out-opens-the-form
  Rule: A code that leaves something out opens the form, already filled in
    Where the site still needs something from the customer, they get the normal
    booking form — with whatever the code did say already filled in for them.

    @case:printed-code.the-form-opens-with-the-name-filled-in
    Scenario: A code cannot answer everything the listing asks
      Given a Workshop is on sale at 5.00, and asks the customer for an email
      When the organiser makes a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer reads that code
      Then the customer is not sent off to pay
      And the form is already filled in with the name "Ada Lovelace"

  @rule:bookings.a-code-that-cannot-be-trusted-books-nothing
  Rule: A code that cannot be trusted books nothing
    A code that has been changed since it was printed, or that points at
    something no longer for sale, does not book anything and does not charge
    anyone.

    @case:printed-code.a-changed-code-is-refused
    Scenario: Someone changes the code before reading it
      Given a Workshop is on sale at 5.00
      When the organiser makes a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer reads that code after it has been changed
      Then the customer is told the code does not work
      And nothing was booked for the Workshop

    @case:printed-code.a-code-for-something-withdrawn
    Scenario: The organiser takes something off sale after printing the codes
      Given a Workshop is on sale at 5.00
      When the organiser makes a code for the Workshop for "Ada Lovelace" at 12.00
      And the organiser takes the Workshop off sale
      And a customer reads that code
      Then the customer cannot open it at all
      And nothing was booked for the Workshop
