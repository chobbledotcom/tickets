@story:records.keeping-only-what-is-needed
@owner:records @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The organiser keeps only the personal details the site still needs
  The site sells tickets; it does not keep files on people. When a listing is
  deleted, anyone who booked only that listing is left behind with nothing to
  attach to, and the organiser can clear those records out. When somebody asks
  to be forgotten, the organiser can delete the note the site keeps about them
  without touching the bookings they made.

  @rule:records.records-left-behind-can-be-cleared-out
  @surface:admin
  Rule: Records left behind by a deleted listing can be cleared out
    The organiser is told how many records are left behind, and chooses how old
    one must be before it goes. Only the delete button deletes anything; saving
    the choice leaves every record where it is.

    @case:privacy.a-deleted-listing-leaves-a-record-behind
    Scenario: Deleting a listing leaves the booking behind
      Given Ada has booked the Pottery Class
      When the organiser deletes the Pottery Class
      Then the site says 1 record is left behind

    @case:privacy.clearing-out-the-records-left-behind
    Scenario: The organiser clears out the records left behind
      Given Ada has booked the Pottery Class
      And the organiser deletes the Pottery Class
      When the organiser deletes the records left behind, choosing "any age (delete straight away)"
      Then the organiser is told 1 record was deleted
      And the site says no records are left behind

    @case:privacy.saving-the-choice-deletes-nothing
    Scenario: Saving the choice deletes nothing
      Given Ada has booked the Pottery Class
      And the organiser deletes the Pottery Class
      When the organiser saves "any age (delete straight away)" and turns automatic deleting off
      Then the site says 1 record is left behind

    @case:privacy.the-choice-is-waiting-next-time
    Scenario: The organiser's choice is waiting for them next time
      When the organiser saves "1 year" and turns automatic deleting off
      Then the page comes back offering "1 year" with automatic deleting off

  @rule:records.maintenance-removes-finished-payment-work-only
  @surface:public
  Rule: Scheduled maintenance removes finished payment work and keeps work a payment can still need
    The site's scheduled maintenance clears old finished SumUp checkouts. A
    checkout that may still be holding money nobody has accounted for stays
    however old it is, and the recovery pass can still ask about it. A
    checkout finished inside its retention window stays too.

    @case:records.maintenance-prunes-only-finished-checkouts
    Scenario: Maintenance removes old finished checkouts and keeps the rest
      Given an old finished SumUp checkout, an equally old one still waiting to hear, and a recent finished one
      When scheduled maintenance runs
      Then the old finished checkout is gone
      And the waiting checkout is still there, still due for its next check
      And the recent checkout is still there

  @rule:records.staged-answers-stay-while-a-payment-can-arrive
  @surface:public
  Rule: Staged buyer answers stay while a payment can still arrive
    A checkout's staged answers outlive the checkout itself, for the
    confirmation email and a late payment callback. Maintenance removes them
    once the site no longer holds the checkout's payment link, and keeps them
    while it does, however old they are.

    @case:records.answers-kept-while-the-link-is-held
    Scenario: Maintenance keeps the answers a held link can still need
      Given an old buyer's answers for a checkout whose payment link has ended but whose link the site still holds
      And an equally old buyer's answers for a checkout whose link the site no longer holds
      And a recent buyer's answers for a checkout still inside its window
      When scheduled maintenance runs
      Then the answers the site still holds a link for are kept
      And the answers whose link is gone are removed
      And the answers inside their window are kept

  @rule:records.one-person-can-be-forgotten
  @surface:admin
  Rule: One person can be forgotten without losing their bookings
    The note the site keeps to recognise a returning customer is deleted by the
    email or phone they booked with. Their bookings belong to the listings they
    booked and stay exactly where they are.

    @case:privacy.forgetting-someone-by-their-email
    Scenario: The organiser forgets somebody found by their email
      Given Ada has booked the Pottery Class, giving an email and a phone number
      When the organiser deletes the record kept about Ada's email
      Then the organiser is told the record was deleted
      And the site counts nothing about Ada's email
      And Ada is still booked on the Pottery Class

    @case:privacy.forgetting-someone-by-their-phone
    Scenario: The organiser forgets somebody found by their phone number
      Given Ada has booked the Pottery Class, giving an email and a phone number
      When the organiser deletes the record kept about Ada's phone number
      Then the organiser is told the record was deleted
      And the site counts nothing about Ada's phone number

    @case:privacy.nobody-of-that-name
    Scenario: The organiser looks for somebody the site never saw
      When the organiser deletes the record kept about an email nobody booked with
      Then the organiser is told there was nothing to delete

    @case:privacy.not-saying-whose-record
    Scenario: The organiser presses delete without saying whose record
      When the organiser deletes a record without saying whose
      Then the organiser is told to enter an email or phone number
