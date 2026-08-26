@story:attendees.the-ticket-a-customer-holds
@owner:attendees @risk:high
@actor:customer
@edition:managed @edition:self-hosted
Feature: The ticket a customer holds after booking
  Booking hands the customer a link of their own. It opens a page holding one
  ticket for each thing they booked, carrying the details the organiser filled
  in, the file they attached, and a code for the door. The link is the only way
  in, so a code the site does not know opens nothing at all.

  @rule:attendees.a-link-holds-one-ticket-for-each-thing-booked
  @surface:public
  Rule: A link holds one ticket for each thing booked
    The link a customer is given after booking opens every ticket that order
    bought, and says how many there are. Asking for the same ticket twice over
    still holds one, and a code the site does not know is passed over rather
    than taking the whole page down with it.

    @case:ticket.one-thing-booked-one-ticket
    Scenario: A customer books one thing
      Given the site sells a Pottery
      When Ada books 1 place on the Pottery
      Then Ada is holding 1 ticket
      And the ticket names the Pottery

    @case:ticket.two-things-booked-two-tickets
    Scenario: A customer books two things in one order
      Given the site sells a Pottery
      And the site sells a Canoe
      When Ada orders 1 place on the Pottery and 2 on the Canoe
      Then Ada is holding 2 tickets
      And the ticket names the Pottery
      And the ticket names the Canoe

    @case:ticket.the-same-code-asked-for-twice
    Scenario: A customer asks for the same ticket twice over
      Given the site sells a Pottery
      And Ada books 1 place on the Pottery
      When Ada asks for that ticket twice over in one link
      Then Ada is holding 1 ticket
      And the ticket names the Pottery

    @case:ticket.an-unknown-code-among-known-ones
    Scenario: A customer's link carries a code the site does not know
      Given the site sells a Pottery
      And Ada books 1 place on the Pottery
      When Ada asks for that ticket alongside a made-up code
      Then Ada is holding 1 ticket
      And the ticket names the Pottery

    @case:ticket.a-made-up-code-opens-nothing
    Scenario: Somebody tries a made-up code
      Given the site sells a Pottery
      When somebody opens a made-up ticket code
      Then the site tells them there is no such page

  @rule:attendees.a-ticket-carries-the-details-of-what-was-booked
  @surface:public
  Rule: A ticket carries the details of what was booked
    The ticket repeats what the organiser wrote about the thing — when and
    where it is, what it is, whether it may be passed on — beside how many
    places the customer took and the file the organiser attached. What the
    organiser left blank puts nothing on the ticket.

    @case:ticket.everything-the-organiser-filled-in
    Scenario: The organiser filled everything in
      Given the site sells a Concert, filled in with
        | when it is       | 2026-06-15T14:00  |
        | where it is      | Village Hall      |
        | what it is       | A night of song   |
        | may be passed on | no                |
        | file to hand out | Running order.pdf |
      When Ada books 3 places on the Concert
      Then the ticket names the Concert
      And the ticket says it is on "15 June 2026" at "Village Hall"
      And the ticket describes it as "A night of song"
      And the ticket says 3 places were taken
      And the ticket says it may not be passed on
      And the ticket offers "Running order.pdf" to download

    @case:ticket.nothing-the-organiser-left-blank
    Scenario: The organiser filled nothing in
      Given the site sells a Pottery
      When Ada books 1 place on the Pottery
      Then the ticket names the Pottery
      And the ticket says 1 place was taken
      And the ticket says nothing about when or where it is
      And the ticket describes nothing
      And the ticket says nothing about being passed on
      And the ticket offers nothing to download

  @rule:attendees.a-ticket-says-what-was-paid-for-it
  @surface:public
  Rule: A ticket says what was paid for it
    A ticket that cost money says how much was paid for it. A free one says
    nothing about price, rather than saying that nothing was paid.

    @case:ticket.what-was-paid-is-shown
    Scenario: A customer pays for their place
      Given the site sells a Concert
      When Ada pays 15.00 for a place on the Concert
      Then the ticket says 15.00 was paid

    @case:ticket.a-free-booking-shows-no-price
    Scenario: A customer books something free
      Given the site sells a Pottery
      When Ada books 1 place on the Pottery
      Then the ticket says nothing about a price

  @rule:attendees.a-ticket-booked-by-the-day-says-which-day-it-is-for
  @surface:public
  Rule: A ticket booked by the day says which day it is for
    A thing booked for a chosen day puts that day on the ticket. A thing not
    sold by the day has no such day, and its ticket does not pretend to one —
    even when it sits beside a day booking on the same link.

    @case:ticket.a-day-booking-shows-its-day
    Scenario: A customer books a day
      Given the site sells a Cabin by the day
      When Ada books the Cabin for the day they picked
      Then the ticket says it is booked for the day they picked

    @case:ticket.an-ordinary-booking-has-no-day
    Scenario: A customer books something not sold by the day
      Given the site sells a Pottery
      When Ada books 1 place on the Pottery
      Then the ticket gives no booked day

    @case:ticket.a-day-booking-beside-an-ordinary-one
    Scenario: One link holds a day booking and an ordinary one
      Given the site sells a Cabin by the day
      And the site sells a Pottery
      And Ada books the Cabin for the day they picked
      And Ada books 1 place on the Pottery
      When Ada asks for every ticket in one link
      Then Ada is holding 2 tickets
      And the ticket names the Pottery
      And the ticket says it is booked for the day they picked

  @rule:attendees.a-ticket-carries-a-code-for-the-door
  @surface:public
  Rule: A ticket carries a code for the door
    The door reads a code off the ticket, so the ticket both prints that code
    and shows a picture of it to hold up.

    @case:ticket.the-code-and-its-picture
    Scenario: A customer looks at the code on their ticket
      Given the site sells a Pottery
      When Ada books 1 place on the Pottery
      Then the ticket prints the code Ada was given
      And the ticket shows a picture of that code to scan

  @rule:attendees.a-bundle-is-one-ticket-not-one-for-each-part
  @surface:public
  Rule: A bundle is one ticket, not one for each part
    Buying a bundle hands over one ticket for the whole bundle. A private
    bundle names only itself and how many were bought. Buying one of its parts
    on its own is a different thing, and gets that part's own ticket.

    @case:ticket.a-private-bundle-is-one-ticket
    Scenario: A customer buys a private bundle
      Given a private Kit bundle holding a Widget
      When Ada buys 3 of the Kit
      Then Ada is holding 1 ticket
      And the ticket names the Kit
      And the ticket never names the Widget
      And the ticket says 3 of them were bought

    @case:ticket.a-part-bought-alone-keeps-its-own-ticket
    Scenario: A customer buys a bundled thing on its own
      Given an open Pack bundle holding a Handbook with "Handbook.pdf" to hand out
      When Ada books 1 place on the Handbook
      Then the ticket names the Handbook
      And the ticket never names the Pack

    @case:ticket.an-open-bundle-keeps-each-parts-file
    Scenario: A customer buys an open bundle whose part has a file
      Given an open Pack bundle holding a Handbook with "Handbook.pdf" to hand out
      When Ada buys 1 of the Pack
      Then Ada is holding 1 ticket
      And the ticket names the Pack
      And the ticket names the Handbook
      And the ticket offers "Handbook.pdf" to download
