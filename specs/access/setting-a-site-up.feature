@story:access.setting-a-site-up
@owner:access @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: Somebody sets a new site up
  A site arrives with nothing in it — no owner, nothing for sale, nobody who
  can sign in. The first person to open it sets it up: they choose a name and a
  password, say which country they are in, and accept the terms. That happens
  once, and from then on the site belongs to them.

  @rule:access.a-site-nobody-set-up-is-not-open
  Rule: A site nobody has set up is not open
    Until somebody sets it up there is nothing to show and nobody to sign in
    as, so the site says it is not ready rather than pretending to be a shop
    with nothing in it.

    @case:setup.not-open-yet
    Scenario: Somebody arrives before the site is set up
      Given nobody has set the site up
      Then a newcomer is told the site is not ready
      And the way to set it up is there for them

  @rule:access.setting-up-makes-the-first-owner
  Rule: Setting up makes the first owner
    The name and password chosen during setup are the ones that work
    afterwards. Setting up and then not being able to sign in would leave the
    site permanently shut, with nobody able to try again.

    @case:setup.first-owner-can-sign-in
    Scenario: Somebody sets the site up
      Given nobody has set the site up
      When somebody sets the site up
      Then they are told the site is set up
      And the owner they made can sign in

  @rule:access.the-password-must-be-typed-the-same-twice
  Rule: The password must be typed the same twice
    The password is typed twice because losing it cannot be undone — nobody can
    read the attendees again. Two boxes that disagree means one of them is a
    typo, so the site refuses rather than locking the owner out of their own
    site with a password they never meant.

    @case:setup.passwords-must-match
    Scenario: The two passwords disagree
      Given nobody has set the site up
      When somebody sets the site up typing a different password the second time
      Then they are told the passwords do not match
      And the site is still not set up
      And the site can still be set up afterwards

  @rule:access.a-site-is-only-set-up-once
  Rule: A site is only set up once
    Once it has an owner there is nothing left to set up, so the setup page
    stops offering it and sends whoever opens it away. A second run would
    otherwise be a way to take somebody's site from them.

    @case:setup.only-once
    Scenario: Somebody opens the setup page afterwards
      Given the site has been set up
      Then opening the way to set it up leads away from it

    @case:setup.stale-form-cannot-take-over
    Scenario: Somebody sends a setup page they opened before
      Given nobody has set the site up
      And somebody else already had the setup page open
      When somebody sets the site up
      And they send their setup after the site is somebody's
      Then the site still belongs to the first owner
