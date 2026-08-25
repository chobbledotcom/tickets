@story:access.removing-a-persons-access
@owner:access @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The owner removes a person's access to the site
  Somebody who should no longer help run the site is removed by the owner
  from the Users list. Removing a person deletes their account and ends
  every window they signed in with, so it asks for their exact name first.
  A wrong name removes nobody, and a removed person cannot sign in again.

  @rule:access.removing-needs-the-persons-exact-name
  Rule: Removing a person needs their exact name
    Typing the name confirms which person is meant, because the removal
    cannot be undone. A wrong name removes nobody and the person keeps
    their access.

    @case:access.wrong-name-removes-nobody
    Scenario: The owner types the wrong name
      Given the owner invited Sam as a manager
      And Sam accepted the invitation, chose a password and signed in
      When the owner tries to remove Sam, typing sammy to confirm
      Then the owner is told the username does not match
      And the Users list still offers Sam
      And Sam can still sign in

  @rule:access.a-removed-person-cannot-come-back-in
  Rule: A removed person cannot come back in
    The removal takes the account itself, not just a way in. The person
    disappears from the Users list and their password no longer signs them
    in anywhere.

    @case:access.exact-name-removes-them
    Scenario: The owner types Sam's exact name
      Given the owner invited Sam as a manager
      And Sam accepted the invitation, chose a password and signed in
      When the owner removes Sam, typing Sam to confirm
      Then the owner is told Sam was deleted
      And the Users list no longer offers Sam
      And Sam cannot sign in any more
      And Sam's own window is signed out
