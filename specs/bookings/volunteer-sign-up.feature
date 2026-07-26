@story:bookings.volunteer-sign-up
@owner:attendees @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A volunteer signs up for a free shift
  A volunteer can choose one shift and share an access need without paying.
  The organiser can see the volunteer and their answer on the chosen shift.

  @rule:bookings.free-shift-is-recorded
  Rule: A free shift sign-up appears on the organiser's attendee list
    The confirmation and attendee list show the shift the volunteer chose.

    @case:bookings.volunteer-chooses-shift
    Scenario: Sam signs up for the set-up shift
      Given Oakfield has three volunteer shifts with eight places each
      When Sam signs up for the set-up shift and asks for step-free access
      Then Sam receives a free booking confirmation for the set-up shift
      And the organiser sees Sam and the access note on the set-up shift
