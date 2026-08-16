@story:catalogue.choosing-a-bulk-action-for-a-group
@owner:catalogue @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser chooses what to do with a group from a landing page
  An organiser with a group of listings opens the group's bulk-actions
  page to see what they can do with the whole group at once. The page
  always offers a copy, and it offers taking the group off sale or
  bringing it back only when the action would do something — taking off
  sale needs at least one listing still on sale, and bringing back
  waits until every listing is off sale. An empty group has nothing to
  switch either way, so only the copy is offered.

  @rule:catalogue.bulk-actions-landing-offers-copy-and-deactivate-when-active
  Rule: A group with active listings offers copy and deactivate
    When every listing in the group is on sale, the organiser can copy
    the group or take it off sale. The reactivate action is not offered,
    because there is nothing off sale to bring back.

    @case:catalogue.bulk-actions-landing-all-active
    Scenario: An all-active group offers copy and deactivate
      Given the site has a group called "Workshops" with "Spring Workshop" on sale
      When the organiser opens the bulk actions page for the "Workshops" group
      Then the organiser is offered a way to copy the group
      And the organiser is offered a way to take the group off sale
      And the organiser is not offered a way to bring the group back on sale
      And the page says it holds 1 listing

  @rule:catalogue.bulk-actions-landing-offers-copy-and-reactivate-when-inactive
  Rule: A group with no active listings offers copy and reactivate
    When every listing in the group is off sale, the organiser can copy
    the group or bring it back on sale. The deactivate action is not
    offered, because there is nothing on sale to take off.

    @case:catalogue.bulk-actions-landing-all-inactive
    Scenario: An all-inactive group offers copy and reactivate
      Given the site has a group called "Finished" with "Old Season" on sale
      And "Old Season" is taken off sale
      When the organiser opens the bulk actions page for the "Finished" group
      Then the organiser is offered a way to copy the group
      And the organiser is offered a way to bring the group back on sale
      And the organiser is not offered a way to take the group off sale
      And the page says it holds 1 listing

  @rule:catalogue.bulk-actions-landing-mixed-and-empty-groups
  Rule: A mixed group can still be taken off sale; an empty group offers only the copy
    A group with some listings on sale and some off can still be copied
    and taken off sale — the deactivate link needs only one listing
    still on sale. Bringing the group back needs every listing to be off
    sale, so a mixed group is not offered it. A group with no listings
    has nothing to switch either way, so only the copy is offered.

    @case:catalogue.bulk-actions-landing-mixed
    Scenario: A mixed group offers copy and deactivate but not reactivate
      Given the site has a group called "Mixed" with "Active One" on sale
      And the site has a group called "Mixed" with "Inactive One" on sale
      And "Inactive One" is taken off sale
      When the organiser opens the bulk actions page for the "Mixed" group
      Then the organiser is offered a way to copy the group
      And the organiser is offered a way to take the group off sale
      And the organiser is not offered a way to bring the group back on sale
      And the page says it holds 2 listings

    @case:catalogue.bulk-actions-landing-empty
    Scenario: An empty group offers only the copy
      Given the site has a group called "Empty" with no listings
      When the organiser opens the bulk actions page for the "Empty" group
      Then the organiser is offered a way to copy the group
      And the organiser is not offered a way to take the group off sale
      And the organiser is not offered a way to bring the group back on sale
      And the page says it holds 0 listings
