@story:settings.writing-the-emails-the-site-sends
@owner:settings @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The owner writes the emails the site sends
  Two emails go out when somebody books: a confirmation to the person who
  booked, and a notification to the business. The site has wording of its own
  for both, and the owner can put their own in its place. The boxes are left
  empty until they do, showing the site's wording behind them, so the owner
  can see what they are replacing before they replace it. What they write is
  read for sense before it is kept, because a template the site cannot read is
  one that would break every email after it.

  @rule:email-templates.the-page-shows-what-it-would-send-already
  Rule: The page shows what the site would send already
    Both templates are offered by name, with the site's own wording showing
    through the empty boxes and a way to start from it rather than a blank
    page. Nothing is filled in until the owner fills it in.

    @case:email-templates.the-page-offers-both-templates
    Scenario: The owner opens their advanced settings
      When the owner opens their advanced settings
      Then both email templates are offered by name
      And the boxes say to leave them blank for the site's own wording
      And the site's own wording shows through the empty boxes
      And there is a way to start from the site's own wording

  @rule:email-templates.the-owner-puts-their-own-wording-in
  Rule: The owner puts their own wording in, and it is kept
    A saved template replaces the site's own for that email. All three parts
    are kept: the subject line, the HTML body, and the plain-text body that
    goes to people whose reader shows no HTML.

    @case:email-templates.writing-the-confirmation-email
    Scenario: The owner writes their own confirmation email
      When the owner writes the confirmation email as:
        | subject | Your places at {{ listing_names }} |
        | html    | <b>{{ attendee.name }}</b>         |
        | text    | Hi {{ attendee.name }}             |
      Then the confirmation email is kept exactly as it was written

    @case:email-templates.writing-the-admin-notification
    Scenario: The owner writes their own notification email
      When the owner writes the admin email as:
        | subject | New booking from {{ attendee.name }} |
        | html    | <p>Somebody booked</p>              |
        | text    | Somebody booked                     |
      Then the admin email is kept exactly as it was written

  @rule:email-templates.emptying-the-boxes-goes-back-to-the-sites-wording
  Rule: Emptying the boxes goes back to the site's own wording
    There is no separate way to undo a custom template, so clearing the boxes
    is how the owner puts the site's own wording back.

    @case:email-templates.clearing-a-custom-template
    Scenario: The owner clears what they wrote
      Given the owner has written their own confirmation email
      When the owner writes the confirmation email as:
        | subject |  |
        | html    |  |
        | text    |  |
      Then the confirmation email goes back to the site's own wording

  @rule:email-templates.wording-the-site-cannot-read-is-refused
  Rule: Wording the site cannot read is refused
    A template is read for sense before it is kept. One the site cannot read
    would break every email sent after it, and the owner would not find out
    until somebody booked, so it is refused at the moment it is written and
    nothing is stored.

    @case:email-templates.a-template-the-site-cannot-read
    Scenario: The owner writes something the site cannot read
      When the owner writes the confirmation email as:
        | subject | {% for x in items %}unclosed |
        | html    |                              |
        | text    |                              |
      Then the owner is told the template syntax is wrong
      And the confirmation email goes back to the site's own wording
