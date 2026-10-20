@story:attendees.checking-people-in-with-no-connection
@owner:attendees @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The door keeps working when the connection drops
  The door's device saves its own copy of the door's ticket list when the
  scanner page loads, with every ticket answered only as a digest the ticket
  can never be read back from. With the connection gone, the door still
  knows a saved ticket when it sees one: the check-in waits on the device
  and sends, once, when the connection is back. The page shows offline mode
  in plain sight, and a quiet switch turns it on and off by hand.

  @rule:attendees.the-door-saves-its-tickets-without-the-tickets-themselves
  @surface:admin
  Rule: The door saves its tickets without the tickets themselves
    The saved list a door's device holds is digests only, so a read of the
    device hands over nothing that opens a door. The list stops answering
    after 12 hours and the next online load replaces it, so a device does
    not carry a door's digests forever.

    @case:offline.the-saved-list-is-digests-only
    Scenario: The door's saved list holds digests only
      Given Alice has a ticket for the Ceilidh
      When the organiser opens the Ceilidh door
      Then the Ceilidh door's saved list holds Alice's ticket as a digest only

  @rule:attendees.a-queued-check-in-sends-once-when-the-connection-is-back
  @surface:admin
  Rule: A queued check-in sends once when the connection is back
    The device sends a queued check-in by the digest it stored, because it
    never held the ticket itself. The door answers it exactly as it answers
    a live scan, so a queued check-in is never lost and never counted twice.

    @case:offline.the-queued-check-in-lets-them-in
    Scenario: The queued check-in lets the person in when it sends
      Given Alice has a ticket for the Ceilidh
      When the door sends Alice's queued check-in at the Ceilidh door
      Then the door lets Alice in

    @case:offline.two-doors-held-the-same-queued-check-in
    Scenario: A queued check-in another door already took says so
      Given Alice has a ticket for the Ceilidh
      When the door sends Alice's queued check-in at the Ceilidh door
      And the door sends Alice's queued check-in at the Ceilidh door
      Then the queued check-in said Alice was already checked in elsewhere

  @rule:attendees.offline-mode-is-plain-to-see-and-quiet-to-switch
  @surface:admin
  Rule: Offline mode is plain to see and quiet to switch
    While the door works offline, the page says so in a banner, and the
    check-ins that wait on the device are counted on the page. The switch
    sits beside the camera button, worded plainly and styled quietly, so
    the door can turn offline mode on and off by hand.

    @case:offline.the-page-carries-its-offline-switch
    Scenario: The door page shows the offline switch and the waiting count
      Given Alice has a ticket for the Ceilidh
      When the organiser opens the Ceilidh door
      Then the Ceilidh door page carries its offline switch and waiting count
