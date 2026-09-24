@story:catalogue.removing-a-listing-from-a-group
@owner:catalogue @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser removes a listing from a group's own page
  An organiser with a group of listings opens the group's page to take one
  listing out of the group. The remove form lists the group's own listings.
  Sending it opens a page that names the chosen members, says what happens
  to their bookings and their prices, and asks for the group's name. The
  removal happens only after the name matches. A listing taken out this way
  can be added back through the same page's add form.

  @rule:catalogue.group-page-removes-a-listing
  Rule: The group's page removes the chosen listings after a typed confirmation
    The remove form on the group's page lists only the group's own
    listings. Sending it opens a confirmation page that names the chosen
    members and asks for the group's name. Only a matching name removes
    them. The page then shows the group without them, and the add form
    offers them again.

    @case:catalogue.group-page-removes-one-chosen-listing
    Scenario: The organiser removes one listing from the group
      Given the site has a group called "Shows" with "Friday Social" on sale
      And the site has a group called "Shows" with "Saturday Gig" on sale
      When the organiser removes "Saturday Gig" from the "Shows" group's page
      Then the organiser is told the listings were removed from the group
      And the "Shows" group's page no longer offers "Saturday Gig" for removal
      And the "Shows" group's page offers "Saturday Gig" for adding again

    @case:catalogue.group-page-removal-asks-for-the-name
    Scenario: A removal with the wrong name changes nothing
      Given the site has a group called "Shows" with "Saturday Gig" on sale
      When the organiser tries to remove "Saturday Gig" from the "Shows" group's page, typing "Shoes" instead
      Then the organiser is told the group name does not match
      And the "Shows" group's page still offers "Saturday Gig" for removal

    @case:catalogue.group-page-removal-states-the-stakes
    Scenario: The removal page says what happens to the members
      Given the site has a group called "Shows" with "Saturday Gig" on sale
      When the organiser chooses "Saturday Gig" for removal from the "Shows" group's page
      Then the removal page names "Saturday Gig"
      And the removal page says each listing keeps its bookings and its money

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
