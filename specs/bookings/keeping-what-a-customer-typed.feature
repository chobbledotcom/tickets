@story:bookings.keeping-what-a-customer-typed
@owner:bookings @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
Feature: A refused order keeps what the customer typed
  An order can be refused after the form was filled in: somebody else can take
  the last places first, or nothing was picked at all. The page that comes back
  says why, and everything the customer typed is still filled in, ready to send
  again. Nothing has to be typed twice.

  @rule:bookings.a-refusal-keeps-the-counts-and-contact-details
  @surface:public
  Rule: A refusal keeps the counts and the contact details
    The count chosen for each thing still on offer stays chosen — a count of
    none included, because leaving one thing out is a choice too — and the
    name and email stay typed in.

    @case:typed.counts-and-contact-details-survive
    Scenario: Somebody takes the last place of one thing in the order
      Given the shop sells an Alpha and a Bravo, and a Charlie booked by the day with room for 1 a day
      And a customer filled the page selling all three in, asking for 3 Alpha, no Bravo, and the last Charlie for a day soon
      When another customer takes 1 Charlie place first
      And the customer sends the form
      Then the customer is told the Charlie no longer has enough room
      And the page still has 3 chosen for the Alpha and none for the Bravo
      And the customer's name and email are still typed in

  @rule:bookings.a-refusal-keeps-every-kind-of-choice
  @surface:public
  Rule: A refusal keeps every kind of choice a listing offers
    Whatever the listing asks for — a price the customer chose to pay, the day
    a booking is for, how many days a stay covers, the answer to a question —
    a refused order hands the choice back still filled in.

    @case:typed.a-chosen-price-survives
    Scenario: The customer chose what to pay
      Given a Donation booked by the day that lets customers pay what they like, with room for 2 places a day
      And a customer filled the Donation page in, asking for 2 places for a day soon and choosing to pay £25.00
      When another customer takes 1 Donation place first
      And the customer sends the form
      Then the customer is told the tickets are no longer available
      And the £25.00 the customer chose to pay is still filled in

    @case:typed.a-chosen-day-survives
    Scenario: The customer picked the day a booking is for
      Given a Sauna that is booked 1 day at a time, with room for 2 places a day
      And a customer filled the Sauna page in, asking for 2 places starting in 5 days
      When another customer takes 1 Sauna place first
      And the customer sends the form
      Then the customer is told the Sauna no longer has enough room
      And the day the customer picked is still chosen

    @case:typed.a-chosen-stay-length-survives
    Scenario: The customer picked how many days a stay covers
      Given a Retreat where customers pick up to 3 days themselves
      And a customer filled the Retreat page in, asking for 5 places on a 2-day stay starting in 5 days
      When another customer takes 1 Retreat place first
      And the customer sends the form
      Then the customer is told the Retreat no longer has enough room
      And the 2-day stay the customer picked is still chosen

    @case:typed.a-chosen-answer-survives
    Scenario: The customer answered the listing's question
      Given a Workshop booked by the day with room for 2 places a day that asks "Lunch?" with the answers "Falafel" and "Halloumi"
      And a customer filled the Workshop page in, asking for 2 places for a day soon and answering "Halloumi"
      When another customer takes 1 Workshop place first
      And the customer sends the form
      Then the customer is told the Workshop no longer has enough room
      And the customer's answer "Halloumi" is still picked

  @rule:bookings.an-agreed-terms-box-stays-ticked
  @surface:public
  Rule: An agreed terms box stays ticked when something else fails
    Terms are agreed once. A refusal about something else hands the form back
    with the box still ticked, not cleared to be agreed to again.

    @case:typed.the-terms-tick-survives
    Scenario: The customer agrees to the terms but picks nothing
      Given a Ticket to book, where orders must agree to terms first
      When a customer sends the form agreeing to the terms but asking for nothing
      Then the customer is told to pick at least one thing
      And the terms box is still ticked
