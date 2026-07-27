@story:attendees.the-record-kept-about-someone
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser reads and corrects the record kept about someone
  The site keeps a little history for each person who deals with it: how many
  times they booked, how often they have been in touch, and a private note only
  the organiser sees. It is filed under a one-way code made from their email, so
  the address itself is never stored. The organiser can read that record and put
  it right whenever it is wrong.

  @rule:attendees.the-organiser-can-read-what-is-kept
  @surface:admin
  Rule: The organiser can read what is kept about someone
    The counts are shown as numbers they can edit, and the private note is shown
    written out. Someone the site has never seen has a record of nothing.

    @case:contact-record.a-record-with-a-history-behind-it
    Scenario: The organiser opens the record of someone who has booked before
      Given the site has seen Sam book 5 times and get in touch 4 times
      When the organiser opens Sam's record
      Then the record shows Sam booked 5 times through the site
      And the record shows Sam has been in touch 4 times
      And the record shows the note about Sam written out

    @case:contact-record.someone-the-site-has-never-seen
    Scenario: The organiser opens the record of a stranger
      When the organiser opens Nobody's record
      Then the record shows nothing was ever counted
      And the record says they have never been in touch

  @rule:attendees.the-organiser-can-put-the-record-right
  @surface:admin
  Rule: The organiser can put the record right
    Whatever they type is what the site keeps from then on.

    @case:contact-record.correcting-the-counts-and-the-note
    Scenario: The organiser corrects someone's counts and note
      Given the site has seen Sam book 5 times and get in touch 4 times
      When the organiser sets Sam's bookings to 11 and note to "Paid in cash"
      Then the record shows Sam booked 11 times through the site
      And the note kept about Sam is "Paid in cash"
      When the organiser sets Sam's messages to 7
      Then the record shows Sam has been in touch 7 times
      And Sam is counted as having been in touch 7 times

    @case:contact-record.a-blank-count-means-none
    Scenario: The organiser clears a count
      When the organiser leaves Sam's site bookings blank
      Then Sam is counted as having booked no times at all

  @rule:attendees.correcting-one-record-leaves-the-others-alone
  @surface:admin
  Rule: Correcting one person's record leaves everyone else's alone
    Each record belongs to one person, so an edit must never reach another.

    @case:contact-record.the-other-person-is-untouched
    Scenario: The organiser edits one of two records
      Given the site has a note about Ali saying "Ali's own note"
      When the organiser sets Sam's bookings to 5 and note to "Sam's own note"
      Then the note kept about Ali is still "Ali's own note"
      And the note kept about Sam is "Sam's own note"

  @rule:attendees.a-record-the-site-cannot-read-can-still-be-repaired
  @surface:admin
  Rule: A record the site cannot read can still be opened and repaired
    If the private note becomes unreadable, the page still opens and still shows
    the counts, which are kept in plain sight. The organiser can save over it
    and get a working record back without losing what was counted.

    @case:contact-record.repairing-an-unreadable-record
    Scenario: The organiser opens a record whose note cannot be read
      Given Sam's record cannot be read, but says 5 site bookings and 9 visits
      When the organiser opens Sam's record
      Then the record shows Sam booked 5 times through the site
      And the record shows Sam has visited 9 times
      When the organiser saves Sam's record again with the note "Repaired"
      Then the note kept about Sam is "Repaired"
      And Sam is still counted as having booked 5 times and visited 9
