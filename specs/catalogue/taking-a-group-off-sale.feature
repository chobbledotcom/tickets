@story:catalogue.taking-a-group-off-sale
@owner:catalogue @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser takes a whole group of listings off sale at once
  An organiser with a group of listings — a season of workshops, a set
  of rooms — can take every listing in the group off sale in one action,
  so that none of them can be booked until they are brought back. The
  organiser confirms by typing the group's name, because taking
  something off sale affects every booking page, every payment, and
  every page a buyer might reach. A wrong name leaves everything as it
  was, and listings that belong to a different group are not touched.

  @rule:catalogue.deactivate-takes-every-member-off-sale
  Rule: A confirmed deactivation takes every member off sale
    When the organiser types the group's name to confirm, every listing
    in the group is taken off sale at once. There is no partial
    deactivation — either the name matches and every member goes off
    sale, or it does not and nothing changes.

    @case:catalogue.deactivate-confirms-and-takes-every-member-off-sale
    Scenario: The organiser takes a group off sale by typing its name
      Given the site has a group called "Workshops" with "Spring Workshop" on sale
      And the site has a group called "Workshops" with "Autumn Workshop" on sale
      When the organiser takes the "Workshops" group off sale, typing its name to confirm
      Then the organiser is sent to the "Workshops" group's page
      And the confirmation form says it will deactivate 2 active listing(s)
      And every listing in the "Workshops" group is off sale

  @rule:catalogue.deactivate-refuses-a-wrong-name
  Rule: A wrong name is refused and nothing changes
    Typing the wrong name when confirming leaves every listing in the
    group exactly as it was — on sale and untouched. The organiser is
    told the name does not match, so they can try again rather than
    thinking it worked.

    @case:catalogue.deactivate-refuses-with-a-wrong-name
    Scenario: The organiser types a name that does not match
      Given the site has a group called "Keep Active" with "Listing One" on sale
      When the organiser tries to take the "Keep Active" group off sale, typing "Wrong Name" instead
      Then the organiser is told the group name does not match
      And the organiser is still on the "Keep Active" group's deactivate form
      And the confirmation form says it will deactivate 1 active listing(s)
      And every listing in the "Keep Active" group is still on sale

  @rule:catalogue.deactivate-leaves-other-groups-alone
  Rule: A deactivation does not touch listings outside the group
    Taking a group off sale only affects the listings in that group.
    Listings in a different group — or ones with no group at all — stay
    on sale, so the organiser's action on one group never reaches into
    another.

    @case:catalogue.deactivate-keeps-other-groups-on-sale
    Scenario: The organiser deactivates one group while another stays on sale
      Given the site has a group called "Target" with "Target Listing" on sale
      And the site has a group called "Other" with "Outsider Listing" on sale
      And the site has a listing called "Ungrouped Listing" on sale with no group
      When the organiser takes the "Target" group off sale, typing its name to confirm
      Then the organiser is sent to the "Target" group's page
      And the confirmation form says it will deactivate 1 active listing(s)
      And every listing in the "Target" group is off sale
      And listings outside the "Target" group are still on sale
