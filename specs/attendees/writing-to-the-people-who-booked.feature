@story:attendees.writing-to-the-people-who-booked
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner writes to the people who booked
  The owner can write one message to everyone booked onto a listing. They
  reach it from the listing itself, write the message, and are shown it before
  anything goes out. For the site to send it for them they need an email
  provider of their own, and a message that promotes something leaves out
  anyone who asked not to hear from them.

  @rule:attendees.the-message-is-shown-before-it-goes
  Rule: The message is shown before it goes
    Writing a message never sends it. The owner is shown what they wrote and
    who it would reach, and only then offered a way to send it.

    @case:writing.see-it-before-it-goes
    Scenario: The owner is shown the message before sending
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      When the owner writes to "the Gig" saying "Doors open at seven."
      Then the owner is shown the message before it goes
      And the owner is shown that it would reach 2 people
      And the site offers to send it for them

    @case:writing.sending-writes-to-everyone-who-booked
    Scenario: Sending reaches everyone who booked
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And the owner has written to "the Gig" saying "Doors open at seven."
      When the owner sends it
      Then the owner is told it went to 2 people
      And it was written to everyone who booked onto "the Gig"

  @rule:attendees.the-site-only-sends-for-them-with-a-provider-of-their-own
  Rule: The site only sends for them with a provider of their own
    Without a provider of their own the owner can still write and check a
    message, and the preview still offers to open it as a draft in their own
    email app. What needs a provider is the site sending it for them, and the
    preview says so rather than leaving a button that would not work.

    @case:writing.no-provider-no-send
    Scenario: The owner has set up no email provider
      Given 2 people have booked onto "the Gig"
      When the owner writes to "the Gig" saying "Doors open at seven."
      Then the owner is shown the message before it goes
      And the owner is told sending is switched off
      And the site does not offer to send it for them
      And the owner is still offered a draft to send themselves

  @rule:attendees.a-promotion-leaves-out-anyone-who-asked-not-to-hear
  Rule: A promotion leaves out anyone who asked not to hear
    A message marked as a promotion skips anyone who has unsubscribed. The
    owner is told how many are being left out, and a promotion with nobody
    left to write to is refused rather than sent to no one.

    @case:writing.a-promotion-skips-the-unsubscribed
    Scenario: One of the two has unsubscribed
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And one of them has asked not to hear about promotions
      When the owner writes a promotion to "the Gig" saying "Half price Friday."
      Then the owner is told 1 person will be left out
      When the owner sends it
      Then it was written to everyone who booked onto "the Gig" but the one who asked

    @case:writing.a-promotion-with-nobody-left
    Scenario: Everybody has unsubscribed
      Given the owner has an email provider of their own
      And 1 person has booked onto "the Gig"
      And they have asked not to hear about promotions
      And the owner has written a promotion to "the Gig" saying "Half price Friday."
      When the owner sends it
      Then the owner is told everyone has asked not to hear
      And nothing was written to anybody

  @rule:attendees.news-about-a-booking-still-reaches-everyone
  Rule: News about a booking still reaches everyone
    A message that is not a promotion is news about something the person
    booked, so it reaches them whether or not they unsubscribed from
    promotions.

    @case:writing.news-still-reaches-the-unsubscribed
    Scenario: Someone who unsubscribed still hears about their own booking
      Given the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And one of them has asked not to hear about promotions
      And the owner has written to "the Gig" saying "The doors have moved."
      When the owner sends it
      Then it was written to everyone who booked onto "the Gig"

  @rule:attendees.the-way-in-is-only-offered-where-it-works
  Rule: The way in is only offered where it works
    The listing offers a way to write to its attendees only when there is
    somebody there to write to, so the owner is never given a link that leads
    nowhere.

    @case:writing.no-addresses-no-way-in
    Scenario: Nobody who booked left an address
      Given the owner has an email provider of their own
      And 1 person has booked onto "the Gig" leaving no address
      Then "the Gig" offers no way to write to the people who booked

    @case:writing.somebody-to-write-to-offers-the-way-in
    Scenario: Somebody left an address
      Given the owner has an email provider of their own
      And 1 person has booked onto "the Gig"
      Then "the Gig" offers a way to write to the people who booked
