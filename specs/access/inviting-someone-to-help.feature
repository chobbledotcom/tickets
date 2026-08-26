@story:access.inviting-someone-to-help
@owner:access @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The owner invites somebody to help
  The owner adds the people who may sign in from one page: a name, and what
  that person is allowed to do. The site hands back a one-time link to pass on,
  and the person invited chooses their own password from it — the owner never
  sets one and never learns it. That one list holds everybody who may sign in,
  beside what each may do and whether they have joined yet.

  @rule:access.an-invite-hands-back-a-link-to-pass-on
  Rule: An invite hands back a link to pass on
    The owner is given the link there and then, on the page they land on, and
    told how long it lasts. That link is the only way in for the person
    invited, so an invite handing back nothing has invited nobody.

    @case:invites.the-owner-is-given-a-link
    Scenario: The owner invites a manager
      When the owner invites Sam as a manager
      Then the owner is given a link to send Sam
      And the owner is told how long that link lasts

  @rule:access.the-list-says-who-may-sign-in-and-what-each-may-do
  Rule: The list says who may sign in, and what each may do
    One list holds the owner and every person invited, beside what they may do
    and whether they have joined yet. Somebody invited is on it from the moment
    the invite is made, marked as not yet joined, so an invite that was never
    passed on is still there to see.

    @case:invites.the-list-holds-everybody
    Scenario: The owner looks at who may sign in
      Given the owner invites Sam as a manager
      And the owner invites Ada as an editor
      When the owner looks at who may sign in
      Then the list says Sam is a manager who has not joined yet
      And the list says Ada is an editor who has not joined yet
      And the list holds the owner as well

  @rule:access.a-name-already-in-use-is-refused
  Rule: A name already in use is refused
    Two people cannot share a name, because the name is how each of them signs
    in. The owner is told the name is taken, and nobody is added — not even an
    invite waiting to be used.

    @case:invites.a-name-already-in-use
    Scenario: The owner invites somebody under a name already taken
      Given the owner invites Sam as a manager
      When the owner invites Sam as an editor
      Then the owner is told that name is taken
      And only the owner and Sam may sign in
