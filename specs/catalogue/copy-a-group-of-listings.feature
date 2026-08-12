@story:catalogue.copy-a-group-of-listings
@owner:catalogue @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser copies a whole group of listings at once
  An organiser with several related listings — a season of workshops, a set
  of rooms — can copy the whole group in one action and get back a new,
  independent group whose members have the same settings as the originals.
  The organiser chooses a new name for the group and may rename or re-date
  its members as part of the same step. A copy whose name would clash with
  something already on the site is refused before anything is written, so
  the organiser's own list never ends up with two listings or groups that
  share a name.

  @rule:catalogue.a-copied-group-is-independent
  Rule: A copied group is a real, separate set of listings
    The new group's members are their own listings: each one has its own
    page, its own settings, and its own name, and changing one of them
    changes nothing about the original it was copied from.

    @case:catalogue.copy-creates-independent-group
    Scenario: The organiser copies a group and renames and re-dates its members
      Given the site has a group called "Workshops" with "Spring Workshop" starting on "2026-04-16"
      When the organiser copies the "Workshops" group as "Autumn Workshops", renaming "Spring" to "Autumn" and shifting the date from "2026-04-16" to "2026-04-23"
      Then the organiser's list offers the "Autumn Workshops" group
      And the "Autumn Workshops" group has one member called "Autumn Workshop", starting on "2026-04-23"
      And the original "Workshops" group still has "Spring Workshop" starting on "2026-04-16"

  @rule:catalogue.a-copy-keeps-names-and-dates-when-told-nothing
  Rule: A copy keeps each member's name and date when the organiser gives no replacements
    Leaving the replacement fields blank means each member is copied with
    the name and date it already had, except that a member whose name would
    then clash with the original is refused — names are unique across the
    site, so a verbatim copy has to be renamed to be allowed through.

    @case:catalogue.copy-keeps-name-and-date-when-no-replacements
    Scenario: The organiser copies a group with a new name on its members but no date shift
      Given the site has a group called "Days Out" with "Day Trip" starting on "2026-05-01"
      When the organiser copies the "Days Out" group as "Days Out (copy)", renaming "Day Trip" to "Renamed Trip"
      Then the "Days Out (copy)" group has one member called "Renamed Trip", starting on "2026-05-01"
      And the original "Days Out" group still has "Day Trip" starting on "2026-05-01"

  @rule:catalogue.a-copy-keeps-names-unique-across-the-site
  Rule: A copy is refused when its name is already taken
    A listing or group shares its name with another only by being the same
    one. The site refuses to make a copy whose new group name, or any one
    of its members' new names, is already used by another listing or group
    — and refuses it before writing anything, so nothing is left behind.

    @case:catalogue.copy-refuses-a-clashing-name
    Scenario: The organiser copies a group without renaming its members
      Given the site has a group called "Solo" with "Only Member" in it
      When the organiser copies the "Solo" group as "Solo (copy)" with no name replacement
      Then the organiser is told a member would keep a name already taken
      And the "Solo" group still has exactly one member
      And the organiser's list does not offer the "Solo (copy)" group
