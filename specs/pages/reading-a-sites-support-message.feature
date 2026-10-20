@story:pages.reading-a-sites-support-message
@owner:pages @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: A read-only operator reads a site's support message
  A built site carries a support message the operator can edit from its own
  tab. When the site is read-only, the message is there to read as it was
  written — pictures and all — and nothing offers to change it.

  @rule:pages.a-read-only-site-shows-its-message-written-out
  @surface:admin
  Rule: A read-only site shows its message written out
    The message panel shows the stored message with its picture, and offers
    no way to edit the message.

    @case:support-message.read-only-message-shows-its-picture
    Scenario: The operator opens the support message of a read-only site
      Given a built site carries a support message with a picture called "SitePoster" in it
      And the site is read-only
      When the organiser opens the site's Support message tab
      Then the message panel shows the "SitePoster" picture
      And the message panel offers no way to edit the message
