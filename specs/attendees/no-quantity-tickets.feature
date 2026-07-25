@story:attendees.no-quantity-tickets
@owner:attendees @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: Keep an attendee record without a customer ticket
  An organiser can keep a person on a listing without giving them a quantity.
  Customers must only see listings where they still have a real booking.

  @rule:attendees.ticket-follows-quantity
  Rule: A customer ticket follows the quantity on each booking
    A no-quantity record stays visible to the organiser but is not a customer ticket.

    @case:attendee.quantity-removed
    Scenario: The organiser removes the ticket quantity
      Given an attendee has a live Workshop ticket
      When the organiser marks the Workshop booking as no quantity
      Then the Workshop attendee list keeps the attendee without a ticket link
      And the old customer ticket is not available

    @case:attendee.quantity-restored
    Scenario: The organiser restores the ticket quantity
      Given an attendee's Workshop ticket is unavailable because the booking has no quantity
      When the organiser restores the Workshop quantity to two
      Then the same customer ticket is available and shows Workshop
      And the Workshop attendee list links to that ticket

    @case:attendee.mixed-record
    Scenario: One attendee has a booking and a no-quantity record
      Given an attendee has a live RealShow ticket and GhostShow is also available
      When the organiser keeps GhostShow on the record with no quantity
      Then the customer ticket shows RealShow but not GhostShow
      And the RealShow attendee list links to the customer ticket
      And the GhostShow attendee list keeps the attendee without a ticket link
