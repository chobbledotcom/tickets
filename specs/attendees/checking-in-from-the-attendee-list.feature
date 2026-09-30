@story:attendees.checking-in-from-the-attendee-list
@owner:attendees @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser checks people in from the listing's attendee list
  Every booking on a listing's attendee list carries a Check in control, so the
  organiser can mark somebody as arrived straight from the list. The site brings
  them back to the same list, where the booking now offers Check out.

  @rule:attendees.checking-somebody-in-from-the-list
  @surface:admin
  Rule: Checking somebody in from the list marks them in and comes back to the list
    Pressing Check in on a booking marks that booking as arrived. The organiser
    lands back on the same attendee list, and the booking now offers Check out.
    The booking pressed is the one on the list in front of them, so this works
    even when the person also booked another listing.

    @case:checkin-list.checking-somebody-in
    Scenario: The organiser checks somebody in from the attendee list
      Given Alice has a ticket for the Ceilidh
      When the organiser presses Check in on the Ceilidh's attendee list
      Then the organiser is told Alice was checked in
      And the Ceilidh's attendee list offers to check Alice out

    @case:checkin-list.checking-somebody-out
    Scenario: The organiser checks somebody back out from the attendee list
      Given Alice has a ticket for the Ceilidh
      And the organiser presses Check in on the Ceilidh's attendee list
      When the organiser presses Check out on the Ceilidh's attendee list
      Then the organiser is told Alice was checked out
      And the Ceilidh's attendee list offers to check Alice in

    @case:checkin-list.checking-in-somebody-who-booked-another-listing-too
    Scenario: The organiser checks in somebody who also booked another listing
      Given Bruno has a ticket for the Ceilidh and for the Quiz
      When the organiser presses Check in on the Quiz's attendee list
      Then the organiser is told Bruno was checked in
      And the Quiz's attendee list offers to check Bruno out

  @rule:attendees.a-booking-of-several-places-asks-how-many
  Rule: A booking of several places asks how many before it moves
    A booking that covers more than one person links to a page that asks how
    many of its tickets to check in or out. Part of a party can arrive first,
    and the list still knows how many of them are in.

    @case:checkin-list.checking-in-part-of-a-party
    Scenario: The organiser checks in part of a party from the attendee list
      Given Cara has a ticket for 3 places at the Ceilidh
      When the organiser checks in 2 of Cara's tickets from the Ceilidh's attendee list
      Then the organiser is told Cara was checked in
      And the Ceilidh's attendee list says 2 of Cara's 3 tickets are in

    @case:checkin-list.checking-out-part-of-a-party
    Scenario: The organiser checks out one of a party that is all in
      Given Cara has a ticket for 3 places at the Ceilidh
      And the organiser checks in 3 of Cara's tickets from the Ceilidh's attendee list
      When the organiser checks out 1 of Cara's tickets from the Ceilidh's attendee list
      Then the organiser is told Cara was checked out
      And the Ceilidh's attendee list says 2 of Cara's 3 tickets are in
