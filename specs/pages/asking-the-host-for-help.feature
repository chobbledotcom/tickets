@story:pages.asking-the-host-for-help
@owner:pages @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The owner asks the host for help
  The owner can write to the people who run the platform from a page in their
  own admin area. The page is there only when the host listens, it shows the
  words the host wrote for it, and a message leaves from the site's own
  address — so a reply reaches the site rather than a stranger.

  @rule:pages.the-page-is-the-owners-alone
  Rule: The page is the owner's alone
    The page lets its reader reach the host, so only the owner may open it.
    Another signed-in member of staff is refused, and a stranger is asked to
    sign in first.

    @case:support.manager-refused
    Scenario: A manager tries to open the Support page
      Given the host listens for the owner's messages
      And the owner invited Sam as a manager
      And Sam accepted the invitation, chose a password and signed in
      When Sam opens the Support page in his own window
      Then Sam is not allowed to open it

    @case:support.stranger-asked-to-sign-in
    Scenario: A stranger looks for the Support page
      Given the host listens for the owner's messages
      When a stranger opens the Support page
      Then the stranger is asked to sign in first

  @rule:pages.the-page-is-there-only-when-the-host-listens
  Rule: The page is there only when the host listens
    The host decides whether the page exists at all. When no host address is
    configured, the page is gone and nothing links to it.

    @case:support.host-silent
    Scenario: The host has no address configured
      Given the host does not listen for support messages
      Then the owner finds no Support page
      And the settings area offers no link to one

  @rule:pages.the-page-shows-the-hosts-own-words
  Rule: The page shows the host's own words
    The host can write an introduction of their own, and it is shown as they
    wrote it — a heading reads as a heading. With nothing written, the page
    says so plainly.

    @case:support.host-words-shown
    Scenario: The host wrote an introduction
      Given the host listens for the owner's messages
      And the host has written "# Help Center\n\nReach out anytime" on the Support page
      When the owner opens the Support page
      Then the owner reads "Help Center" as a heading and "Reach out anytime" as its words
      And the page does not say the host has written nothing

    @case:support.no-words-fallback
    Scenario: The host wrote nothing
      Given the host listens for the owner's messages
      When the owner opens the Support page
      Then the owner is told the host has written nothing yet

  @rule:pages.the-form-needs-the-sites-own-address
  Rule: The form needs the site's own address
    A support message is sent from the site's business address, so a reply
    reaches the site. With no address set there is nothing to send from and
    the page offers no form. With one set, the owner types a message and
    nothing else — the site already knows who is writing.

    @case:support.no-address-no-form
    Scenario: The site has no business address
      Given the host listens for the owner's messages
      When the owner opens the Support page
      Then the owner is offered no form to write in

    @case:support.message-box-only
    Scenario: The site has a business address
      Given the host listens for the owner's messages
      And the site can send email from "owner@example.com"
      When the owner opens the Support page
      Then the owner is offered a message box and nothing else to fill in

  @rule:pages.a-message-reaches-the-host-and-a-reply-goes-to-the-site
  Rule: A message reaches the host, and a reply goes to the site
    The message is delivered to the host's own address. A reply to it goes to
    the site's business address, and the subject says which site it came
    from — so the host reads it and answers the site, not a stranger.

    @case:support.message-delivered
    Scenario: The owner writes to the host
      Given the host listens for the owner's messages
      And the site can send email from "owner@example.com"
      When the owner writes "Please help me" to the host
      Then the owner is told the message was sent
      And the message reaches the host
      And a reply to it would go to "owner@example.com"
      And the message names the site it came from

    @case:support.nag
    Scenario: The owner comes back soon after sending one
      Given the host listens for the owner's messages
      And the site can send email from "owner@example.com"
      When the owner writes "Please help me" to the host
      And the owner opens the Support page
      Then the owner is reminded they sent a message a moment ago

  @rule:pages.a-support-message-that-did-not-go-is-never-called-sent
  Rule: A message that did not go is never called sent
    When the site cannot deliver, or the owner sends nothing at all, the
    owner is told so and nothing reaches the host.

    @case:support.delivery-failed
    Scenario: The site cannot send the message
      Given the host listens for the owner's messages, but cannot take them right now
      And the site can send email from "owner@example.com"
      When the owner writes "Please help me" to the host
      Then the owner is told it could not be sent

    @case:support.empty-message-refused
    Scenario: The owner sends an empty message
      Given the host listens for the owner's messages
      And the site can send email from "owner@example.com"
      When the owner tries to send a message with nothing in it
      Then the owner is told to enter a message
      And nothing reaches the host
