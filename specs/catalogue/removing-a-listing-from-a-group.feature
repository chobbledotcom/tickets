@story:catalogue.removing-a-listing-from-a-group
@owner:catalogue @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser removes a listing from a group's own page
  An organiser with a group of listings opens the group's page to take one
  listing out of the group. The remove form lists the group's own listings.
  The page says what happens: the listing keeps its bookings, and the
  prices set for it in this group are removed. A listing taken out this
  way can be added back through the same page's add form.

  @rule:catalogue.group-page-removes-a-listing
  Rule: The group's page removes the chosen listings from the group
    The remove form on the group's page lists only the group's own
    listings. The organiser ticks the listings to remove and sends the
    form. The page then shows the group without them, and the add form
    offers them again.

    @case:catalogue.group-page-removes-one-chosen-listing
    Scenario: The organiser removes one listing from the group
      Given the site has a group called "Shows" with "Friday Social" on sale
      And the site has a group called "Shows" with "Saturday Gig" on sale
      When the organiser removes "Saturday Gig" from the "Shows" group's page
      Then the organiser is told the listings were removed from the group
      And the "Shows" group's page no longer offers "Saturday Gig" for removal
      And the "Shows" group's page offers "Saturday Gig" for adding again

  @rule:catalogue.group-page-removal-keeps-other-groups
  Rule: A listing removed from one group keeps its other groups
    One listing can sit in several groups. Removing it from one group
    leaves every other group untouched.

    @case:catalogue.group-page-removal-keeps-every-other-group
    Scenario: The organiser removes a listing from one of its two groups
      Given the site has a group called "Early Shows" with "Meet and Greet" on sale
      And the site also has "Meet and Greet" in the "Late Night" group
      When the organiser removes "Meet and Greet" from the "Early Shows" group's page
      Then the organiser is told the listings were removed from the group
      And the "Early Shows" group's page no longer offers "Meet and Greet" for removal
      And the "Late Night" group's page still offers "Meet and Greet" for removal
