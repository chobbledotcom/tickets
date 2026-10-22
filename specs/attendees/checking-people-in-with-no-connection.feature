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
