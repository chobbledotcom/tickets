@story:access.what-a-scanner-can-do
@owner:access @risk:high
@actor:organiser @actor:scanner
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner gives a door worker the scanner, and nothing else
  A door worker needs to check people in and out, and no more. The site gives
  them a scanner login: after signing in they see the site's doors, they work
  a door by reading tickets, and they undo a check-in on the ticket's own
  page. Every other admin page stays shut, even when they type its address.

  @rule:access.a-scanner-signs-in-and-finds-their-door
  Rule: A scanner signs in and finds their door
    The owner invites them from the Users page like any other helper. The
    scanner chooses their own password, signs in, and lands on the doors,
    which is where their work is.

    @case:scanners.joining-from-an-invite
    Scenario: Someone invited as a scanner sets a password and signs in
      Given the owner invites Sam to work a door
      When Sam follows the door invite and chooses a password
      And Sam signs in
      Then Sam is looking at the doors

    @case:scanners.the-doors-list-their-door
    Scenario: The doors list the door they are to work
      Given Alice has a ticket for the Ceilidh
      And Sam is signed in as a scanner
      When Sam opens the Ceilidh door
      Then the Ceilidh door is open for Sam

  @rule:access.a-scanner-checks-people-in-and-out
  Rule: A scanner checks people in and out
    Reading a ticket at a door checks the person in, exactly as it does for
    the organiser. The ticket's own QR page is where they undo it: the page
    offers to check them out, and checking out really does.

    @case:scanners.reading-a-ticket-lets-them-in
    Scenario: The scanner reads a ticket at the door
      Given Alice has a ticket for the Ceilidh
      And Sam is signed in as a scanner
      When Sam reads Alice's ticket at the Ceilidh door
      Then the door lets Alice in

    @case:scanners.a-re-read-says-so
    Scenario: Reading the same ticket twice says so
      Given Alice has a ticket for the Ceilidh
      And Sam is signed in as a scanner
      When Sam reads Alice's ticket at the Ceilidh door
      And Sam reads Alice's ticket at the Ceilidh door
      Then the door says Alice is already in

    @case:scanners.checking-out-on-the-ticket-page
    Scenario: The scanner checks someone out on the ticket's page
      Given Alice has a ticket for the Ceilidh
      And Sam is signed in as a scanner
      When Sam reads Alice's ticket at the Ceilidh door
      And Sam reads the QR on Alice's ticket
      Then the ticket page offers to check them out
      When Sam checks them out
      Then the site says they were checked out

  @rule:access.a-scanner-reaches-nothing-else
  Rule: A scanner reaches nothing else
    The rest of the admin is not merely unlinked: asking for it outright is
    refused, so there is nothing to find by guessing.

    Scenario Outline: The scanner asks for a page that is not theirs
      Given Sam is signed in as a scanner
      When Sam asks to open the "<page>" page
      Then Sam is turned away

      Examples:
        | case_id                        | page              |
        | scanners.refused-the-attendees | list of attendees |
        | scanners.refused-the-money     | money             |
        | scanners.refused-the-settings  | settings          |
