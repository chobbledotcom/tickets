@story:servicing.keeping-only-what-is-needed
@owner:servicing @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The organiser keeps only the personal details the site still needs
  The site sells tickets; it does not keep files on people. When a listing is
  deleted, anyone who booked only that listing is left behind with nothing to
  attach to, and the organiser can clear those records out. When somebody asks
  to be forgotten, the organiser can delete the note the site keeps about them
  without touching the bookings they made.

  @rule:servicing.records-left-behind-can-be-cleared-out
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

  @rule:servicing.one-person-can-be-forgotten
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
