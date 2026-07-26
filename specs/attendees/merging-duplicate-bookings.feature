@story:attendees.merging-duplicate-bookings
@owner:attendees @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser merges two bookings for the same person
  The same person sometimes books twice. An organiser can fold one booking into
  the other, but when the duplicate has been paid for there is real money at
  stake — so the organiser has to say what happens to it. The system never
  decides that on their behalf.

  @rule:attendees.a-paid-duplicate-needs-a-decision-about-its-money
  @surface:admin
  Rule: A paid duplicate cannot be folded away without deciding about its money
    Leaving the choice out stops the merge and changes nothing at all, so money
    can never be stranded or a place counted twice by accident.

    @case:merge.no-money-decision-is-refused
    Scenario: The organiser tries to merge without saying what happens to the money
      Given the same person paid twice for a Summit place
      When the organiser merges them without saying what to do with the money
      Then the organiser is told a money decision is needed
      And both bookings are still there, still counted

  @rule:attendees.money-handed-back-becomes-the-survivor-credit
  @surface:admin
  Rule: Money handed back to the person becomes credit on the booking they keep
    The listing counts the one place they keep, and the extra money shows on
    their record as credit, so the organiser can see what is owed to them.

    @case:merge.money-becomes-credit
    Scenario: The organiser hands the duplicate's money back to the person
      Given the same person paid twice for a Reunion place
      When the organiser merges them and hands the money back
      Then the Reunion counts one place, at 50.00
      And the booking they keep holds 50.00 of credit
      And the credit is shown on their money page

  @rule:attendees.money-kept-is-written-off-not-earned
  @surface:admin
  Rule: Money the organiser keeps is written off, not counted as earnings
    The listing still counts only the place they keep. The extra money is parked
    as a write-off, so the books stay honest about what was really earned.

    @case:merge.money-is-written-off
    Scenario: The organiser keeps the duplicate's money
      Given the same person paid twice for a Gala place
      When the organiser merges them and keeps the money
      Then the Gala counts one place, at 50.00
      And the person is owed nothing
      And the extra 50.00 is written off

  @rule:attendees.a-free-duplicate-merges-straight-through
  @surface:admin
  Rule: A duplicate with no money merges in one step
    Nothing is at stake, so the organiser is never asked about money.

    @case:merge.free-duplicate-needs-no-decision
    Scenario: The organiser merges two free bookings
      Given the same person booked a free Freebie place twice
      When the organiser looks at merging them
      Then they are not asked what to do with any money
      And merging leaves one booking and no money moved
