@story:access.what-an-editor-can-do
@owner:access @risk:high
@actor:organiser @actor:editor
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner gives someone the run of the listings, and nothing else
  An owner can let somebody help with what the site says without letting them
  near the people who have booked. That helper is an editor: they write and
  change listings, groups and site pages, and that is the whole of it. They
  are never shown a customer's details, what anything earned, or the settings
  that run the site — and they hold no key that could open those details even
  if they found a way to the page.

  @rule:access.an-editor-sets-up-their-own-account
  Rule: An editor sets up their own account from an invite
    The owner invites them by name and hands over a link. The editor chooses
    their own password on that link, and from then on they log in and land on
    the listings, which is where their work is.

    @case:editors.joining-from-an-invite
    Scenario: Someone invited as an editor sets a password and logs in
      Given the owner invites Sam to help with the listings
      When Sam follows the invite and chooses a password
      And Sam logs in
      Then Sam is looking at the listings

  @rule:access.an-editor-writes-what-the-site-says
  Rule: An editor writes what the site says
    Making and changing listings is their job, so the pages for it are theirs
    to use and what they save really is saved. Saving leaves them on the thing
    they just made, where they can carry on and where the site can tell them it
    worked.

    @case:editors.adding-a-listing
    Scenario: The editor adds something to sell
      Given Sam is signed in as an editor
      When Sam adds a listing called Pottery
      Then Pottery is one of the things the site sells
      And Sam is left on Pottery, with the site saying it saved

    @case:editors.changing-a-listing
    Scenario: The editor changes something the site already sells
      Given Sam is signed in as an editor
      And the site sells a Pottery
      When Sam renames the Pottery to Ceramics
      Then Ceramics is one of the things the site sells
      And the site sells nothing called Pottery

  @rule:access.an-editor-is-never-shown-peoples-details-or-money
  Rule: An editor is never shown people's details or money
    Everything about who has booked, what has been earned, and how the site is
    run is closed to an editor. It is not merely unlinked: asking for the page
    outright is refused too, so there is nothing to find by guessing.

    Scenario Outline: The editor asks for a page that is not theirs
      Given Sam is signed in as an editor
      When Sam asks for the "<page>" page
      Then Sam is told it is not theirs to open

      Examples:
        | case_id                       | page              |
        | editors.refused-the-attendees | list of attendees |
        | editors.refused-the-money     | money             |
        | editors.refused-the-people    | people            |
        | editors.refused-the-settings  | settings          |

    @case:editors.nothing-they-cannot-open-is-linked
    Scenario: Every page the editor is offered opens for them
      Given Sam is signed in as an editor
      When Sam opens the listings
      Then Sam is offered the listings and the groups
      And every page Sam is offered is one they can open

    @case:editors.the-listings-show-no-money
    Scenario: The list of things for sale shows an editor no takings
      Given Sam is signed in as an editor
      And somebody has bought and paid for a Pottery
      When Sam opens the listings
      Then Sam is shown no takings for Pottery

  @rule:access.an-editor-cannot-change-where-peoples-details-are-sent
  Rule: An editor cannot change where people's details are sent
    A listing can forward each booking, names and all, to an address the owner
    chose. That address is the owner's alone: it is not on the editor's form,
    and an editor's save leaves it exactly as it was even when the save carries
    a different one.

    @case:editors.the-forwarding-address-is-not-on-their-form
    Scenario: The editor is not shown where bookings are forwarded
      Given Sam is signed in as an editor
      And the site sells a Pottery, forwarding its bookings to the owner's address
      When Sam opens Pottery to edit it
      Then Sam is not asked where bookings are forwarded

    @case:editors.a-crafted-save-cannot-move-the-forwarding-address
    Scenario: An editor's save carries a different forwarding address
      Given Sam is signed in as an editor
      And the site sells a Pottery, forwarding its bookings to the owner's address
      When Sam saves Pottery with somewhere else to forward bookings to
      Then Pottery still forwards its bookings to the owner's address
      When the owner saves Pottery with somewhere else to forward bookings to
      Then Pottery forwards its bookings somewhere else
