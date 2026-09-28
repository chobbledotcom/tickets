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
