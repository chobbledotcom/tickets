@story:attendees.asking-to-be-left-alone
@owner:attendees @risk:high
@actor:customer
@edition:managed @edition:self-hosted
@surface:public
Feature: Somebody the site emails can ask to be left alone
  Every promotion the site sends ends with a link to the reader's own
  choices page. That page is found by a one-way code, never by their
  address, and it is theirs alone: one press stops promotions, a later
  press lets them back in, and a third deletes the record the site
  keeps under their code. A link that has lost its code explains
  itself and offers nothing to press, so a broken link can never
  change anything.

  @rule:attendees.every-promotion-carries-the-way-out
  Rule: Every promotion carries the way out
    The link at the bottom of a promotion leads to the reader's own
    choices page, which tells them where they stand before they press
    anything.

    @case:leave-alone.the-link-leads-to-their-own-page
    Scenario: A reader follows the link at the bottom of a promotion
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And the owner has sent a promotion to "the Gig" saying "Half price Friday."
      When one of them follows the choices link in their copy
      Then they land on their own choices page, still subscribed to promotions

  @rule:attendees.asking-not-to-hear-is-one-press
  Rule: Asking not to hear is one press, and it is kept
    Pressing the button on their own page is all it takes. The reader
    is told it worked, the site counts them as having asked not to
    hear, and the page they are left on offers the way back in rather
    than a dead end.

    @case:leave-alone.one-press-stops-the-promotions
    Scenario: One press stops the promotions
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And the owner has sent a promotion to "the Gig" saying "Half price Friday."
      And one of them follows the choices link in their copy
      When they ask to stop hearing about promotions
      Then they are told they have unsubscribed
      And the site counts them as having asked not to hear
      And their page offers them a way back in

  @rule:attendees.a-change-of-mind-puts-them-back
  Rule: A change of mind puts them back
    Someone who asked not to hear can press the way back in on the
    same page. The site stops counting them as having asked not to
    hear, so promotions may reach them again.

    @case:leave-alone.a-change-of-mind
    Scenario: They change their mind and come back
      Given somebody has asked not to hear about promotions
      When they change their mind on their own choices page
      Then they are told they have resubscribed
      And the site counts them as hearing about promotions again

  @rule:attendees.the-record-under-their-code-can-be-deleted
  Rule: The record under their code can be deleted by them
    The same page offers to delete the record the site keeps under
    their one-way code. After the press the site keeps no record under
    that code at all — including the choices they had made on this
    page.

    @case:leave-alone.deleting-their-own-record
    Scenario: They delete the record the site keeps
      Given somebody has asked not to hear about promotions
      When they delete their data from their choices page
      Then they are told their record was deleted
      And the site keeps no record under their code

  @rule:attendees.a-broken-link-changes-nothing
  Rule: A broken link changes nothing
    A choices link that has lost its code — cut short by an email
    program, or mistyped — explains itself. The page offers nothing to
    press, so nobody's choices can be changed by a link that names no
    one.

    @case:leave-alone.a-broken-link-explains-itself
    Scenario: A link with no code explains itself
      When somebody opens the choices page from a broken link
      Then they are told the link is invalid
      And the page offers them nothing to press
