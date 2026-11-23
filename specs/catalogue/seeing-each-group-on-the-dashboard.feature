@story:catalogue.seeing-each-group-on-the-dashboard
@owner:catalogue @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser sees each group as a card on the dashboard
  An organiser who runs events keeps each event as a group, and each kind of
  ticket for it as a listing in the group. The listings table on the dashboard
  lists every listing in one long table, with filters and figures the
  organiser does not need on the day. The owner can choose group cards as the
  dashboard type instead. The dashboard then shows each group as a card, with
  its listings on sale and the scanner and attendee list the organiser opens.
  The listings table stays one link away.

  @rule:catalogue.the-dashboard-shows-each-group-as-a-card
  Rule: Group cards show each group with its listings on sale
    Each group that still has a listing on sale shows as one card, with its
    listings and a link to its scanner. A listing that is in no group still
    shows, under other listings, so nothing goes missing from the dashboard.

    @case:catalogue.the-dashboard-shows-a-group-card-and-its-listings
    Scenario: The organiser sees a group card with its listings and its door
      Given the site has a group called "Friday Club" with "Friday entry" on sale
      And the site has a listing called "Gift voucher" on sale with no group
      And the owner chooses group cards as the dashboard type
      When the organiser opens the group cards
      Then the dashboard shows "Friday Club" with "Friday entry"
      And the dashboard offers the scanner for "Friday Club"
      And the dashboard shows "Gift voucher" under other listings

  @rule:catalogue.the-listings-table-stays-one-link-away
  Rule: The listings table stays one link away
    The organiser can always open the listings table, and it links back to the
    group cards.

    @case:catalogue.the-listings-table-links-back
    Scenario: The organiser opens the listings table and comes back
      Given the owner chooses group cards as the dashboard type
      When the organiser opens the listings table
      Then the dashboard offers the group cards
