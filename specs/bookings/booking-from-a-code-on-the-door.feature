@story:bookings.booking-from-a-code-on-the-door
@owner:bookings @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer books from a code the organiser shows them
  On the day, the organiser can hold up a phone or a tablet showing a booking
  code for one thing they sell. Whoever scans it goes straight to booking that
  one thing, with everything the organiser already filled in ready for them.
  The code is signed and short-lived: it cannot be altered on the way, and it
  stops working a few minutes after it appears, so a photo of the screen is no
  use later.

  @rule:bookings.a-code-that-says-everything-goes-straight-to-paying
  Rule: A code that says everything sends the customer straight to paying
    If the organiser filled in who it is for and what it costs, there is nothing
    left to ask, so the customer goes straight to paying that amount.

    @case:door-code.straight-to-paying
    Scenario: A customer scans a code with nothing left to fill in
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code
      Then the customer is sent straight off to pay
      And they are asked for 12.00
      And it is for 1 place
      And it is for the Workshop
      And the booking is in the name "Ada Lovelace"

  @rule:bookings.a-code-stops-working-after-a-few-minutes
  Rule: A code stops working a few minutes after it appears
    The code on the screen is only good for a short while, so a photo of it is
    no use later. The organiser is told how long each one lasts, because they
    are the one deciding how long to hold the screen up.

    @case:door-code.a-code-scanned-too-late
    Scenario: A customer scans a code long after it appeared
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code an hour later
      Then the customer is told the code does not work
      And nothing was booked for the Workshop

    @case:door-code.still-good-a-moment-later
    Scenario: A customer scans the code a moment after it appears
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code a minute later
      Then the customer is sent straight off to pay
      And they are asked for 12.00

    @case:door-code.the-organiser-is-told-how-long-it-lasts
    @surface:admin
    Scenario: The organiser sees how long the code on the screen lasts
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      Then the screen says how long each code lasts

  @rule:bookings.the-price-on-the-code-is-what-they-pay
  Rule: The price on the code is what the customer pays
    The organiser can put a one-off price on a code — an offer, a door price, a
    deal — and that is what is charged, not the listing's usual price.

    @case:door-code.the-codes-price-wins
    Scenario: A code carries a price of its own
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code
      Then they are asked for 12.00

    @case:door-code.paying-more-still-wins
    Scenario: A customer chooses to pay more than the code says
      Given a Workshop is on sale at 5.00, and people may pay more
      When the organiser shows a code for the Workshop at 12.00
      And a customer scans that code
      And the customer decides to pay 20.00 instead
      Then they are asked for 20.00

  @rule:bookings.a-code-that-leaves-something-out-opens-the-form
  Rule: A code that leaves something out opens the form, already filled in
    Where the site still needs something from the customer, they get the normal
    booking form — with whatever the code did say already filled in for them.

    @case:door-code.the-form-opens-with-the-name-filled-in
    Scenario: A code cannot answer everything the listing asks
      Given a Workshop is on sale at 5.00, and asks the customer for an email
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code
      Then the booking form opens for them instead
      And the form is already filled in with the name "Ada Lovelace"

  @rule:bookings.a-code-that-cannot-be-trusted-books-nothing
  Rule: A code that cannot be trusted books nothing
    A code that has been changed since it was shown, or that points at
    something no longer for sale, does not book anything and does not charge
    anyone.

    @case:door-code.a-changed-code-is-refused
    Scenario: Someone changes the code before scanning it
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And a customer scans that code after it has been changed
      Then the customer is told the code does not work
      And nothing was booked for the Workshop

    @case:door-code.a-code-for-something-withdrawn
    Scenario: The organiser takes something off sale while the code is up
      Given a Workshop is on sale at 5.00
      When the organiser shows a code for the Workshop for "Ada Lovelace" at 12.00
      And the organiser takes the Workshop off sale
      And a customer scans that code
      Then the customer cannot open it at all
      And nothing was booked for the Workshop
