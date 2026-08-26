@story:attendees.sending-somebody-a-text
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser sends somebody a text message
  Texts go out through a phone the owner runs themselves, so nothing can be
  sent until that gateway is set up and the person has given a number. What
  the organiser writes goes into a queue and joins that person's message
  history, which is where the organiser looks to see what has already been
  said to them. A text that does not get away is said so plainly, because a
  message nobody knows failed is one nobody sends again.

  @rule:sms.the-organiser-sees-what-is-waiting-to-go
  Rule: The organiser sees how many texts are waiting to go
    The page counts the messages that have not reached the phone yet. With
    nobody chosen there is nobody to write to, so it offers no way to write.

    @case:sms.the-queue-with-nobody-chosen
    Scenario: The organiser opens the text messages page
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      And the organiser texts Nina "Doors open at seven"
      And the organiser texts Nina "Bring an apron"
      When the organiser opens the text messages page
      Then the page says 2 messages are waiting to go
      And there is no way to write a text

  @rule:sms.nobody-can-be-texted-until-the-gateway-is-set-up
  Rule: Nobody can be texted until the gateway is set up
    Without the gateway there is nowhere for a text to go, so the page says so
    and offers no way to write one, rather than taking a message it cannot
    send.

    @case:sms.no-gateway-means-no-way-to-write
    Scenario: The organiser opens somebody's page before the gateway is set up
      Given Nina has booked the Pottery, giving a phone number
      When the organiser opens Nina's text messages
      Then the page says the gateway is not set up
      And there is no way to write a text

  @rule:sms.somebody-with-no-number-cannot-be-texted
  Rule: Somebody with no number on file cannot be texted
    A booking that gave no phone number leaves nothing to send to, so the page
    says the number is not on file and offers no way to write.

    @case:sms.no-number-means-no-way-to-write
    Scenario: The organiser opens the page of somebody who gave no number
      Given the gateway is set up
      And Nina has booked the Pottery, giving no phone number
      When the organiser opens Nina's text messages
      Then the page says there is no number on file
      And there is no way to write a text

  @rule:sms.a-text-joins-the-queue-and-the-history
  Rule: A text the organiser writes joins the queue and the history
    The page names the person and the number it will go to, so the organiser
    can see who they are about to text. What they send is queued, they are
    told so, and it joins that person's history. The site counts it against
    that phone as well, so the record it keeps about them is not only email.

    @case:sms.the-page-names-who-is-being-texted
    Scenario: The organiser opens somebody's text messages
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      When the organiser opens Nina's text messages
      Then the page names Nina and the number she gave

    @case:sms.sending-a-text
    Scenario: The organiser sends a text
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      When the organiser texts Nina "Doors open at seven"
      Then the organiser is told the text was queued
      And Nina's history holds "Doors open at seven"
      And the site counts 1 message against Nina's phone

  @rule:sms.a-text-that-does-not-get-away-is-said-so
  Rule: A text that does not get away is said so
    The organiser is told the message was not queued, and the history says so
    too. A failure the site kept to itself would leave the organiser believing
    somebody had been told something they never heard.

    @case:sms.a-text-the-gateway-refuses
    Scenario: The gateway will not take the text
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      And the gateway is refusing everything
      When the organiser texts Nina "Doors open at seven"
      Then the organiser is told the text could not be queued
      And Nina's history says the text could not be queued
      And nothing was queued for Nina

  @rule:sms.a-message-of-nothing-is-refused
  Rule: A message of nothing but spaces is refused
    Spaces would go out as an empty text and cost the owner a send, so the
    site refuses and says why, leaving nothing behind.

    @case:sms.spaces-are-not-a-message
    Scenario: The organiser sends only spaces
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      When the organiser texts Nina "   "
      Then the organiser is told the message cannot be empty
      And nothing was queued for Nina

  @rule:sms.the-history-outlives-the-gateway
  Rule: The history stays when the gateway is switched off
    What was already said to somebody is a record, not a way to send, so it
    stays readable beside the warning even when nothing more can go out.

    @case:sms.the-history-survives-the-gateway-going
    Scenario: The gateway is switched off after a text was sent
      Given the gateway is set up
      And Nina has booked the Pottery, giving a phone number
      And the organiser texts Nina "Doors open at seven"
      When the gateway is switched off
      And the organiser opens Nina's text messages
      Then the page says the gateway is not set up
      And Nina's history holds "Doors open at seven"
