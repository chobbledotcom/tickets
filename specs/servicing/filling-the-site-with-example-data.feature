@story:servicing.filling-the-site-with-example-data
@owner:servicing @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: An organiser fills the site with example data
  A new site is easier to learn with something in it. The organiser can ask
  for example listings, each with example attendees. Everything made this way
  is stored the same way as a real booking, so every page reads it back like
  real data.

  @rule:servicing.example-data-reads-like-real-data
  Rule: Example data reads like real data everywhere the organiser looks
    Example attendees are locked away like real ones, and opened again on
    every page that shows them. The dashboard, the listing's own list of
    attendees, and each attendee's record all read back what was made.

    @case:seeds.what-was-made-can-be-read-everywhere
    Scenario: The organiser looks around after asking for example data
      When the organiser asks for 2 example listings with 1 attendee each
      Then they are told 2 listings and 2 attendees were created
      And an example listing is on the dashboard
      When the organiser opens an example attendee's record from that listing
      Then the record offers the attendee's example name to edit
