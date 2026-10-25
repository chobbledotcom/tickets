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

  @rule:attendees.money-kept-as-credit-shows-on-their-record
  @surface:admin
  Rule: The duplicate's money can be kept as credit for the person
    Nothing is returned to their card. The listing counts the one place they
    keep, and the extra money shows on their record as credit, so the organiser
    can see what is owed to them.

    @case:merge.money-becomes-credit
    Scenario: The organiser keeps the duplicate's money as credit for the person
      Given the same person paid twice for a Reunion place
      When the organiser merges them and keeps it as credit for them
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

  @rule:attendees.the-incoming-booking-can-replace-the-opened-one
  @surface:admin
  Rule: The organiser can keep the incoming booking instead of the opened one
    Choosing the incoming booking replaces what the opened one held — its
    places and its days — and only for the booking the organiser decided
    about. A booking the same person holds through another path, such as
    inside a bundle, is a different booking and is left alone.

    @case:merge.incoming-replaces-the-opened-booking
    Scenario: The organiser keeps the incoming booking of two places
      Given the same person paid twice for a Summit place, the incoming booking holding 2 places and the opened one 1
      When the organiser merges them, keeping the incoming booking and the opened one's money as credit
      Then the Summit counts one booking holding 2 places and no days
      And the booking they keep holds 50.00 of credit
      And the credit is shown on their money page

    @case:merge.incoming-replaces-the-opened-days
    Scenario: The organiser keeps the incoming dated booking
      Given the same person paid twice for a Summit stay starting 14 days from now, the incoming booking holding 2 places over 3 days and the opened one 1 place over 1 day
      When the organiser merges them, keeping the incoming booking and the opened one's money as credit
      Then the booking they keep holds 2 places over those 3 days
      And the booking they keep holds 50.00 of credit
      And the credit is shown on their money page

    @case:merge.replacing-a-bundle-part-leaves-the-rest
    Scenario: Replacing the bundle part leaves the on-its-own booking alone
      Given the same person booked a free Reunion place twice, each booking holding a place inside a bundle and one on its own, the incoming booking holding 2 places and the opened one 1
      When the organiser merges them keeping the incoming bundle part
      Then the bundle part is the incoming one and the on-its-own booking is the one they opened
  @rule:attendees.owed-sends-show-on-the-merge-screen
  @surface:admin
  Rule: The merge screen shows each booking's owed sends before the merge
    Merging deletes the duplicate, so a send it still owes has to be seen
    first. Each booking's notices sit beside its own section, and bookings
    whose sends went out show none.

    @case:merge.owed-sends-show-before-the-merge
    Scenario: The organiser sees each booking's owed sends on the merge screen
      Given the same person booked a free Gala place twice
      And the booking they keep owes an email, and the duplicate owes a webhook
      When the organiser looks at merging them
      Then the kept booking's section says its email never went out
      And the duplicate's section says its webhooks never went out

    @case:merge.a-settled-pair-shows-no-unsent-notices
    Scenario: A pair whose sends went out shows no unsent notices
      Given the same person booked a free Reunion place twice
      When the organiser looks at merging them
      Then neither booking's section says a send never went out
