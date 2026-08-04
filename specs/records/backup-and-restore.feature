@story:records.backup-and-restore
@owner:records @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser puts the site back from a backup
  An organiser can take a backup of everything the site holds. If the site is
  ever emptied, that backup brings the listings and their bookings back.

  @rule:records.emptied-site-starts-blank
  @surface:admin
  Rule: An emptied site holds none of the old listings
    Emptying the site is a real reset, so nothing is left behind to hide a
    failed restore.

    @case:backup.emptied-site-is-blank
    Scenario: The site is emptied and set up again
      Given the organiser has a Summer Concert listing with a booking for Jane Doe
      When the site is emptied and set up again
      Then the dashboard does not show Summer Concert

  @rule:records.backup-brings-bookings-back
  @surface:admin
  Rule: Restoring a backup brings back the listings and their bookings
    The restored site holds the same listings, the same people, and their
    contact details.

    @case:backup.restore-brings-back-bookings
    Scenario: The organiser restores the backup of an emptied site
      Given the organiser has taken a backup of a Summer Concert listing with a booking for Jane Doe
      And the site is emptied and set up again
      When the organiser restores the backup
      Then the dashboard shows Summer Concert
      And the Summer Concert attendee list shows Jane Doe and her email
