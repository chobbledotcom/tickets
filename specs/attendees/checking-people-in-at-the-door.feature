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
    The organiser is told the name on the ticket and how many places it covers,
    so they know how many people to wave through.

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
      Then the door lets Bruno in
      And the door says the ticket covers 4 places

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
      When the organiser reads Alice's ticket at the Quiz door and lets her in anyway
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
      When the organiser reads Alice's ticket at the Ceilidh door having checked her ID
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

    @case:door.a-refunded-person-is-not-offered
    Scenario: The organiser looks for someone whose money was given back
      Given Alice has a ticket for the Ceilidh
      And Alice's Ceilidh ticket has been refunded
      Then the Ceilidh door does not offer Alice
