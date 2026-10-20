@story:attendees.checking-people-in-at-the-door
@owner:attendees @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser checks people in at the door
  On the day, the organiser stands at the door with the listing's scanner open
  and reads each person's ticket. The site tells them who is in front of them,
  how many places that ticket covers, and whether to let them through. It also
  keeps the people already inside off the list, so nobody is counted twice.

  @rule:attendees.a-ticket-for-this-listing-lets-them-in
  @surface:admin
  Rule: A ticket for this listing lets the person in
    The organiser is told the name on the ticket and how many places it covers.
    A ticket that covers several people asks how many are at the door, so part
    of a party can arrive first and the rest still gets in later.

    @case:door.the-first-look-at-a-ticket
    Scenario: The organiser reads a ticket for the listing they are running
      Given Alice has a ticket for the Ceilidh
      When the organiser reads Alice's ticket at the Ceilidh door
      Then the door lets Alice in
      And the door says the ticket covers 1 place

    @case:door.a-ticket-for-a-group
    Scenario: The organiser reads a ticket that covers several people
      Given Bruno has a ticket for 4 places at the Ceilidh
      When the organiser reads Bruno's ticket at the Ceilidh door
      Then the door asks how many tickets for Bruno
      When the organiser says 4 tickets for Bruno at the Ceilidh door
      Then the door lets Bruno in
      And the door says the ticket covers 4 places

    @case:door.part-of-a-party-arrives-first
    Scenario: The organiser checks in part of a party
      Given Cara has a ticket for 3 places at the Ceilidh
      When the organiser reads Cara's ticket at the Ceilidh door
      And the organiser says 2 tickets for Cara at the Ceilidh door
      Then the door lets Cara in
      And the door says the ticket covers 2 of 3 places

    @case:door.the-rest-of-a-party-arrives-later
    Scenario: The rest of the party arrives later
      Given Cara has a ticket for 3 places at the Ceilidh
      And the organiser has checked in 2 of Cara's tickets at the Ceilidh door
      When the organiser reads Cara's ticket at the Ceilidh door
      Then the door lets Cara in
      And the door says the ticket covers 1 of 3 places
    @case:door.a-ticket-for-a-stay-of-several-days
    Scenario: The organiser reads a ticket for a stay of several days
      Given Alice has a ticket for a 3-day stay at the Cabin
      When the organiser reads Alice's ticket at the Cabin door
      Then the door lets Alice in
      When the organiser reads Alice's ticket at the Cabin door
      Then the door says Alice is already in

    @case:door.the-day-is-written-down
    Scenario: The listing's own record of the day shows the check-in
      Given Alice has a ticket for the Ceilidh
      When the organiser reads Alice's ticket at the Ceilidh door
      Then the Ceilidh's record of the day says Alice was checked in
  @rule:attendees.a-ticket-already-used-says-so
  @surface:admin
  Rule: A ticket already used says so
    Reading the same ticket twice does not quietly let someone in again. The
    organiser is told it has been used, and still sees whose it is.

    @case:door.reading-the-same-ticket-twice
    Scenario: The organiser reads a ticket that has already been used
      Given Alice has a ticket for the Ceilidh
      And the organiser reads Alice's ticket at the Ceilidh door
      When the organiser reads Alice's ticket at the Ceilidh door
      Then the door says Alice is already in

  @rule:attendees.a-refunded-ticket-does-not-let-them-in
  @surface:admin
  Rule: A ticket that has been refunded does not let them in
    Once the money is back with the customer, the ticket stops working — but
    the organiser is told whose it is, so they can talk to the right person.

    @case:door.a-refunded-ticket-is-turned-away
    Scenario: The organiser reads a ticket that was refunded
      Given Alice has a ticket for the Ceilidh
      And Alice's Ceilidh ticket has been refunded
      When the organiser reads Alice's ticket at the Ceilidh door
      Then the door says Alice was refunded

  @rule:attendees.a-ticket-for-another-listing-is-queried-not-refused
  @surface:admin
  Rule: A ticket for another listing is queried, not simply refused
    The door names the listing the ticket is really for, so the organiser can
    see what has happened. It is their call: they can still let the person in.

    @case:door.the-wrong-door
    Scenario: The organiser reads a ticket belonging to another listing
      Given Alice has a ticket for the Ceilidh
      And the Quiz is running its own door
      When the organiser reads Alice's ticket at the Quiz door
      Then the door says Alice belongs to the Ceilidh

    @case:door.letting-them-in-anyway
    Scenario: The organiser lets in someone from another listing
      Given Alice has a ticket for the Ceilidh
      And the Quiz is running its own door
      And the organiser reads Alice's ticket at the Quiz door
      When the organiser lets Alice in at the Quiz door anyway
      Then the door lets Alice in

  @rule:attendees.a-listing-that-needs-id-holds-the-ticket-first
  @surface:admin
  Rule: A listing whose tickets cannot be passed on asks for ID first
    Where a ticket cannot be given to someone else, the door holds it until the
    organiser says they have seen the person's ID.

    @case:door.the-door-asks-for-id
    Scenario: The organiser reads a ticket that cannot be passed on
      Given Alice has a ticket for the Ceilidh, which needs ID checked
      When the organiser reads Alice's ticket at the Ceilidh door
      Then the door asks the organiser to check Alice's ID

    @case:door.the-id-is-checked
    Scenario: The organiser checks the ID and lets them in
      Given Alice has a ticket for the Ceilidh, which needs ID checked
      And the organiser reads Alice's ticket at the Ceilidh door
      When the organiser confirms Alice's ID at the Ceilidh door
      Then the door lets Alice in

  @rule:attendees.the-door-only-offers-people-who-are-not-in-yet
  @surface:admin
  Rule: Looking someone up by hand only offers people who are not in yet
    When a ticket cannot be read, the organiser can pick the person from a list.
    That list holds only the people still to arrive, so nobody is let in twice
    and a refunded ticket cannot be waved through by hand.

    @case:door.someone-still-to-arrive-can-be-picked
    Scenario: The organiser looks for someone who has not arrived
      Given Alice has a ticket for the Ceilidh
      Then the Ceilidh door offers Alice by name

    @case:door.someone-already-in-is-not-offered
    Scenario: The organiser looks for someone already inside
      Given Alice has a ticket for the Ceilidh
      And the organiser reads Alice's ticket at the Ceilidh door
      Then the Ceilidh door does not offer Alice

    @case:door.a-part-party-is-offered-for-the-rest
    Scenario: The organiser looks for a party that is partly in
      Given Cara has a ticket for 3 places at the Ceilidh
      And the organiser has checked in 2 of Cara's tickets at the Ceilidh door
      Then the Ceilidh door offers Cara for 1 ticket

    @case:door.a-refunded-person-is-not-offered
    Scenario: The organiser looks for someone whose money was given back
      Given Alice has a ticket for the Ceilidh
      And Alice's Ceilidh ticket has been refunded
      Then the Ceilidh door does not offer Alice

  @rule:attendees.a-door-saves-its-tickets-before-the-connection-goes
  @surface:admin
  Rule: The door saves its tickets before the connection goes
    On load the door keeps the day's tickets as one-way codes, so it can
    still tell a real ticket from a strange one while the site is out of
    reach. The list holds codes only: no ticket in full, and no guest
    detail. A ticket the door would turn away leaves no code behind.

    @case:door.the-door-saves-its-list
    Scenario: The organiser saves the day's tickets at the door
      Given Alice has a ticket for the Ceilidh
      And Bruno has a ticket for the Ceilidh
      When the Ceilidh door saves its tickets for offline reading
      Then the Ceilidh door's saved list holds one-way codes for Alice's and Bruno's tickets
      And the Ceilidh door's saved list holds no ticket code in full
      And the Ceilidh door's saved list names nobody

    @case:door.a-refunded-ticket-saves-no-code
    Scenario: The organiser saves the list after a ticket was refunded
      Given Alice has a ticket for the Ceilidh
      And Alice's Ceilidh ticket has been refunded
      When the Ceilidh door saves its tickets for offline reading
      Then the Ceilidh door's saved list is empty

    @case:door.a-door-with-nobody-to-check-in-saves-an-empty-list
    Scenario: A door with nobody to check in saves an empty list
      Given the Cabin is running its own door
      When the Cabin door saves its tickets for offline reading
      Then the Cabin door's saved list is empty

    @case:door.a-thing-nobody-attends-saves-no-list
    Scenario: The site saves no list for a thing nobody attends
      Given the site sells a Raffle that nobody attends
      When the organiser tries to save the Raffle door's tickets for offline reading
      Then the site saves no list for the Raffle

    @case:door.somebody-without-door-duties-saves-no-list
    Scenario: Somebody without door duties cannot save a door's list
      Given the owner invites Bob to help with the listings
      And Bob follows the invite and chooses a password
      And Alice has a ticket for the Ceilidh
      When Bob asks the Ceilidh door to save its tickets for offline reading
      Then the site refuses to save the Ceilidh's list

  @rule:attendees.a-saved-check-in-is-delivered-by-its-one-way-code
  @surface:admin
  Rule: A saved check-in is delivered by its one-way code
    While the site was out of reach, the door saved its check-ins. When the
    connection is back, the door delivers each one by the code it stored,
    and the door reads the same answer it would have read at the time. A
    code another door stored opens nothing here, and the same delivery
    twice admits nobody twice.

    @case:door.a-saved-delivery-lets-them-in
    Scenario: The organiser delivers a saved check-in
      Given Alice has a ticket for the Ceilidh
      And the Ceilidh door saves its tickets for offline reading
      When the organiser delivers Alice's saved check-in at the Ceilidh door
      Then the door lets Alice in

    @case:door.a-saved-check-in-that-names-nobody-is-refused
    Scenario: The organiser delivers a saved check-in that names nobody
      Given Alice has a ticket for the Ceilidh
      When the organiser delivers a saved check-in that names nobody at the Ceilidh door
      Then the door refuses the saved check-in
      And nobody has let Alice in at the Ceilidh door

    @case:door.a-code-from-another-door-is-refused
    Scenario: The organiser delivers a check-in another door saved
      Given Alice has a ticket for the Quiz
      And the Ceilidh is running its own door
      When the Quiz door saves its tickets for offline reading
      And the organiser delivers the saved check-in the Quiz door saved for Alice at the Ceilidh door
      Then the door refuses the saved check-in
      And nobody has let Alice in at the Ceilidh door

    @case:door.a-saved-delivery-for-a-used-ticket-says-so
    Scenario: The organiser delivers a saved check-in for a ticket already used
      Given Alice has a ticket for the Ceilidh
      And the organiser reads Alice's ticket at the Ceilidh door
      And the Ceilidh door saves its tickets for offline reading
      When the organiser delivers Alice's saved check-in at the Ceilidh door
      Then the door says Alice is already in

    @case:door.a-retried-delivery-lets-no-one-else-in
    Scenario: The organiser delivers the same saved check-in twice
      Given Cara has a ticket for 3 places at the Ceilidh
      And the Ceilidh door saves its tickets for offline reading
      When the organiser delivers 1 of Cara's saved tickets at the Ceilidh door
      And the organiser delivers the same saved check-in again at the Ceilidh door
      Then the door says Cara is already in
      And the Ceilidh door has let 1 of Cara's tickets in
