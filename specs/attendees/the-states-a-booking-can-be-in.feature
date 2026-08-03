@story:attendees.the-states-a-booking-can-be-in
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser names the states a booking can be in
  Every booking sits in one state, and the organiser writes that list
  themselves. One state is where new bookings start; one is where a booking
  lands once its balance is paid. A state can ask for a deposit up front
  instead of the whole price. The organiser puts the list in the order they
  want, and can take a spare state away — but never one the site still needs.

  @rule:attendees.the-organiser-writes-the-list-of-states
  Rule: The organiser writes the list of states
    A state needs a name, and nothing more. One that asks for a deposit says
    how much beside its name. A state cannot both ask for a deposit and mean
    the whole price is paid, because those are opposite things.

    @case:statuses.a-plain-state
    Scenario: The organiser adds a plain state
      When the organiser adds a state called "Waiting"
      Then "Waiting" is one of the states a booking can be in

    @case:statuses.a-name-with-an-and-in-it
    Scenario: The organiser adds a state with an "and" sign in its name
      When the organiser adds a state called "Waiting & Ready"
      Then "Waiting & Ready" is one of the states a booking can be in

    @case:statuses.a-state-that-asks-for-a-deposit
    Scenario: The organiser adds a state that asks for a deposit
      When the organiser adds a state called "Reserved" asking for "10%" up front
      Then the list shows "Reserved" asking for "10%" up front

    @case:statuses.a-deposit-that-is-not-an-amount
    Scenario: The organiser asks for a deposit that is not an amount
      When the organiser adds a state called "Vague" asking for "lots" up front
      Then the organiser is told what a deposit can look like
      And there is no state called "Vague"

    @case:statuses.paid-in-full-and-a-deposit-at-once
    Scenario: The organiser makes a state mean two opposite things
      When the organiser adds a state called "Muddle" asking for "10" up front and meaning the balance is paid
      Then the organiser is told a paid state cannot also ask for a deposit
      And there is no state called "Muddle"

  @rule:attendees.only-one-state-holds-each-job
  Rule: Only one state at a time holds each job
    Two states cannot both be where new bookings start, or both be where a paid
    booking lands. Giving the job to a new state takes it off the old one, so
    the site is never left with two answers to the same question.

    Scenario Outline: The organiser moves a job to a new state
      When the organiser adds a state called "<state>" that is "<job>"
      Then the list marks "<state>" as "<job>"
      And the list no longer marks "Confirmed" as "<job>"

      Examples:
        | case_id                             | state   | job                     |
        | statuses.where-new-bookings-start   | Fresh   | where new bookings start |
        | statuses.where-a-paid-booking-lands | Settled | where a paid booking lands |

  @rule:attendees.a-state-the-site-still-needs-cannot-be-taken-away
  Rule: A state the site still needs cannot be taken away
    Taking a state away means typing its name, so it is never done by accident.
    Even then the site keeps the ones it cannot do without: the last one left,
    and the one new bookings start in.

    @case:statuses.a-spare-state-goes
    Scenario: The organiser takes a spare state away
      Given the organiser has added a state called "Spare"
      When the organiser takes "Spare" away, typing "Spare"
      Then there is no state called "Spare"

    @case:statuses.the-wrong-name-changes-nothing
    Scenario: The organiser types the wrong name
      Given the organiser has added a state called "Spare"
      When the organiser takes "Spare" away, typing "Sparse"
      Then the organiser is told the name does not match
      And "Spare" is one of the states a booking can be in

    @case:statuses.the-last-state-stays
    Scenario: The organiser tries to take the only state away
      When the organiser takes "Confirmed" away, typing "Confirmed"
      Then the organiser is told at least one state must be kept
      And "Confirmed" is one of the states a booking can be in

    @case:statuses.the-state-new-bookings-start-in-stays
    Scenario: The organiser tries to take away where new bookings start
      Given the organiser has added a state called "Spare"
      When the organiser takes "Confirmed" away, typing "Confirmed"
      Then the organiser is told to choose another starting state first
      And "Confirmed" is one of the states a booking can be in

  @rule:attendees.the-organiser-decides-the-order
  Rule: The organiser decides the order the states come in
    The list is read top to bottom, so the organiser can move a state up it.
    The one already at the top is offered no way further, which is how the site
    says there is nowhere left to go.

    @case:statuses.moving-a-state-up
    Scenario: The organiser moves a state up the list
      Given the organiser has added states called "First" and "Second"
      When the organiser moves "Second" up
      Then the states are offered in the order "Confirmed", "Second", "First"

    @case:statuses.the-top-state-goes-no-further
    Scenario: The state at the top has nowhere to go
      Given the organiser has added a state called "Spare"
      Then "Confirmed" is already at the top of the list
