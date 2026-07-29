@story:servicing.hearing-from-a-visitor
@owner:servicing @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A visitor writes to the owner
  Somebody looking at the site can write to the owner without booking anything
  and without signing in — a question about a listing, a request, a complaint.
  The message leaves as an email to the address the owner gave, and the visitor
  is told plainly whether it went.

  @rule:servicing.the-form-is-there-only-when-the-owner-set-it-up
  Rule: The form is there only when the owner set it up
    Taking messages needs two things: the form switched on, and an address for
    them to reach. With either missing there is nothing for a visitor to write
    in, so the site does not offer a form it could not deliver from.

    @case:contact.form-offered
    Scenario: The owner is set up to hear from people
      Given the owner takes messages
      Then a visitor is offered a form to write in

    @case:contact.form-switched-off
    Scenario: The owner switches the form off
      Given the owner takes messages
      When the owner takes away the form
      Then a visitor is offered no form

    @case:contact.no-address-to-reach
    Scenario: The owner has no address for messages to reach
      Given the owner takes messages
      When the owner takes away their address
      Then a visitor is offered no form

  @rule:servicing.a-message-reaches-the-owner-and-can-be-replied-to
  Rule: A message reaches the owner, and a reply goes back to the visitor
    The message is sent to the owner's own address, and replying to it answers
    the person who wrote — not the site. Otherwise the owner reads it and has
    no way to write back.

    @case:contact.message-delivered
    Scenario: A visitor writes to the owner
      Given the owner takes messages
      When a visitor writes in from "asker@outside.test"
      Then the visitor is told it was sent
      And the message reaches the owner
      And a reply to it would go to "asker@outside.test"

  @rule:servicing.a-sender-claiming-the-owners-own-address-is-flagged
  Rule: A sender claiming the owner's own address is flagged
    Somebody can type any address into the form. When they claim one on the
    owner's own email host the message still arrives, but a reply goes to the
    site rather than to the claimed address — replying to it would look like
    the owner writing to themselves — and the owner is warned what they are
    reading.

    @case:contact.sender-claims-the-owners-host
    Scenario: A sender claims an address on the owner's own host
      Given the owner takes messages
      When a visitor writes in claiming the owner's own address
      Then the message reaches the owner
      And a reply to it would not go to the claimed address
      And the owner is warned the sender may be pretending

  @rule:servicing.a-message-that-did-not-go-is-never-called-sent
  Rule: A message that did not go is never called sent
    When the site cannot deliver, the visitor is told so and asked to try
    later. Telling them it was sent would leave them waiting for an answer
    nobody ever received.

    @case:contact.delivery-failed
    Scenario: The site cannot send the message
      Given the owner takes messages, but sending is broken
      When a visitor writes in from "asker@outside.test"
      Then the visitor is told it could not be sent

    @case:contact.spam-check-turned-it-down
    Scenario: The spam check turns a message down
      Given the owner takes messages, with spam protection turning them down
      When a visitor writes in from "asker@outside.test"
      Then the visitor is told it could not be checked
      And nothing reaches the owner
