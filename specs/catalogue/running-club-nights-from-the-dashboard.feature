@story:catalogue.running-club-nights-from-the-dashboard
@owner:catalogue @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser runs club nights from a simpler dashboard
  An organiser who runs club nights keeps each night as a group, and each
  ticket for the night as a listing in it. The full dashboard lists every
  listing in one long table, with filters and figures the organiser does not
  need on the night. The owner can turn on the club night dashboard. The
  dashboard then shows each night with its listings on sale, and the doors and
  attendee lists the organiser opens. The full dashboard stays one link away.

  @rule:catalogue.the-dashboard-shows-each-night
  Rule: The club night dashboard shows each night with its listings on sale
    Each group that still has a listing on sale shows as one night, with its
    listings and a link to its scanner. A listing that is in no group still
    shows, under other listings, so nothing goes missing from the dashboard.

    @case:catalogue.the-dashboard-shows-a-night-and-its-listings
    Scenario: The organiser sees a night with its listings and its door
      Given the site has a group called "Friday Club" with "Friday entry" on sale
      And the site has a listing called "Gift voucher" on sale with no group
      And the owner enables "Club night dashboard"
      When the organiser opens the club night dashboard
      Then the dashboard shows "Friday Club" with "Friday entry"
      And the dashboard offers the scanner for "Friday Club"
      And the dashboard shows "Gift voucher" under other listings

  @rule:catalogue.the-full-dashboard-stays-one-link-away
  Rule: The full dashboard stays one link away
    The organiser can always open the full dashboard, and it links back to the
    club night dashboard.

    @case:catalogue.the-full-dashboard-links-back
    Scenario: The organiser opens the full dashboard and comes back
      Given the owner enables "Club night dashboard"
      When the organiser opens the full dashboard
      Then the dashboard offers the club night dashboard
