@story:access.changing-the-owners-password
@owner:access @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The owner changes their own password
  The owner can change the password they sign in with, from the settings
  page. A new password is only accepted when the old one is proved and the
  two copies of the new one are typed the same way. Changing it signs out
  every window, including the one it was changed from, and only the new
  password works afterwards.

  @rule:access.a-new-password-is-only-accepted-when-proved
  Rule: A new password is only accepted when proved
    The site will not hand the owner's account to a stranger at the keyboard.
    The current password must be typed correctly, and the two copies of the
    new one must match. A refused change changes nothing: the old password
    still signs in.

    @case:password.wrong-current-refused
    Scenario: The owner types the current password wrongly
      Given the owner is signed in, in their own window
      When the owner tries to change their password, typing the current one wrongly
      Then the owner is told the current password is incorrect
      And the old password still signs them in

    @case:password.mismatched-copies-refused
    Scenario: The owner confirms the new password differently
      Given the owner is signed in, in their own window
      When the owner tries to change their password, confirming it differently
      Then the owner is told the new passwords do not match
      And the old password still signs them in

  @rule:access.a-changed-password-signs-every-window-out
  Rule: A changed password signs every window out
    One password change ends every signed-in window, because any of them can
    belong to somebody who should no longer be here. The owner reads that the
    password changed, signs in again with the new password, and cannot sign
    in with the old one any more.

    @case:password.change-signs-out-and-lets-them-back-in
    Scenario: The owner changes their password
      Given the owner is signed in, in their own window
      When the owner changes their password to a-new-long-password
      Then the owner is told the password changed and to log in again
      And their old window is signed out
      And they can sign in with the new password
      And they cannot sign in with the old one
