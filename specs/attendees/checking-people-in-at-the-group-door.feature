@story:attendees.checking-people-in-at-the-group-door
@owner:attendees @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser checks people in at a group's door
  On the day, the organiser opens one scanner for a whole group, so door staff
  never switch scanners between the group's admission tiers. The site tells
  them who is in front of them and which tier the ticket holds. A ticket that
  covers several of the group's tiers is let in one tier at a time, so every
  later door still has something to admit — or the group can turn on its own
  checkbox and let one scan admit everything the ticket holds.

  @rule:attendees.any-tier-of-a-group-lets-them-in-at-its-door
  @surface:admin
  Rule: A ticket for any tier of the group lets the person in
    The group's own scanner answers for every tier the group holds, so the
    door staff read each ticket once.

    @case:group-door.the-first-tier
    Scenario: The organiser reads a Standard ticket at the group door
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Standard tier
      When the organiser reads Alice's ticket at the Festival group door
      Then the door lets Alice in
      And the door says the ticket holds the Standard

    @case:group-door.the-second-tier
    Scenario: The organiser reads a Society ticket at the group door
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Society tier
      When the organiser reads Alice's ticket at the Festival group door
      Then the door lets Alice in
      And the door says the ticket holds the Society

  @rule:attendees.a-group-door-queries-outside-tickets
  @surface:admin
  Rule: A ticket for a listing outside the group is queried, not refused
    The group door names the listing the ticket really belongs to. It is the
    organiser's call: they can still let the person in.

    @case:group-door.a-ticket-belonging-elsewhere
    Scenario: The organiser reads a ticket for a listing outside the group
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Quiz
      When the organiser reads Alice's ticket at the Festival group door
      Then the door says Alice belongs to the Quiz

    @case:group-door.letting-them-in-anyway
    Scenario: The organiser lets someone from outside the group in anyway
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Quiz
      And the organiser reads Alice's ticket at the Festival group door
      When the organiser lets Alice in at the Festival group door anyway
      Then the door lets Alice in

  @rule:attendees.a-group-ticket-is-admitted-one-tier-at-a-time
  @surface:admin
  Rule: A ticket that covers several tiers is admitted one tier at a time
    Each scan admits one tier and names it, so a later door still has
    something to admit. Only when nothing remains does the door say the
    person is already in.

    @case:group-door.one-tier-at-a-time
    Scenario: The organiser reads a ticket for two tiers
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Standard and Society tiers
      When the organiser reads Alice's ticket at the Festival group door
      Then the door lets Alice in
      And the door says the ticket holds the Standard
      When the organiser reads Alice's ticket at the Festival group door
      Then the door lets Alice in
      And the door says the ticket holds the Society
      When the organiser reads Alice's ticket at the Festival group door
      Then the door says Alice is already in

  @rule:attendees.a-group-door-can-admit-every-tier-at-once
  @surface:admin
  Rule: The group's own checkbox lets one scan admit every tier
    The group's page offers a checkbox: "Check in every listing in this group
    when scanning any". With it on, one scan admits every tier the ticket
    holds.

    @case:group-door.the-checkbox-admits-every-tier
    Scenario: The organiser turns the checkbox on and reads a two-tier ticket
      Given a group door for the Festival holds the Standard and Society tiers
      And the Festival door checks in every listing when scanning
      And Alice has a ticket for the Standard and Society tiers
      When the organiser reads Alice's ticket at the Festival group door
      Then the door lets Alice in
      And the door says the ticket holds the Standard and the Society
      When the organiser reads Alice's ticket at the Festival group door
      Then the door says Alice is already in

  @rule:attendees.the-group-door-offers-people-not-in-yet
  @surface:admin
  Rule: Looking someone up by hand at the group door only offers people who are not in yet
    The list holds one entry per person, whatever tiers their ticket covers,
    and a person with nothing left to admit is not offered.

    @case:group-door.someone-still-to-arrive-can-be-picked
    Scenario: The organiser looks for someone who has not arrived
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Standard and Society tiers
      Then the Festival group's scanner offers Alice by name

    @case:group-door.someone-fully-in-is-not-offered
    Scenario: The organiser looks for someone whose whole ticket is used
      Given a group door for the Festival holds the Standard and Society tiers
      And Alice has a ticket for the Standard and Society tiers
      And the Festival door checks in every listing when scanning
      And the organiser reads Alice's ticket at the Festival group door
      Then the Festival group's scanner does not offer Alice
