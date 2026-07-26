@story:attendees.editing-and-moving
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser edits an attendee and moves them between listings
  An organiser keeps an attendee's details up to date without disturbing what
  the attendee has booked, and can move a booking from one listing to another.

  @rule:attendees.contact-changes-keep-the-booking
  @surface:admin
  Rule: Changing an attendee's details leaves their booking alone
    The new details are kept, the number of places stays the same, and a
    check-in is neither added nor lost.

    @case:attendee.checked-in-details-changed
    Scenario: The organiser edits an attendee who is checked in
      Given Alice Smith is checked in for Art Class with two places
      When the organiser renames her to Alice Johnson and saves new contact details
      Then Alice Johnson's record shows her new contact details
      And Alice Johnson still has two Art Class places and is still checked in
      And the Art Class attendee list does not show Alice Smith

    @case:attendee.not-checked-in-details-changed
    Scenario: The organiser edits an attendee who is not checked in
      Given Bob Jones has one Art Class place and is not checked in
      When the organiser renames him to Robert Jones and saves new contact details
      Then Robert Jones's record shows his new contact details
      And Robert Jones still has one Art Class place and is not checked in

  @rule:attendees.places-can-move-between-listings
  @surface:admin
  Rule: An organiser can move an attendee's place to another listing
    Giving a place on the new listing and taking the place off the old one
    moves the attendee without deleting their record.

    @case:attendee.moved-between-listings
    Scenario: The organiser moves two attendees to another listing
      Given Alice Smith and Bob Jones each have a Morning Workshop place
      When the organiser moves both of them to Evening Seminar
      Then Morning Workshop has no attendees
      And Evening Seminar shows Alice Smith and Bob Jones
