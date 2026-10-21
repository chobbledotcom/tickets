# The offline scanner's storage layer

The offline scanner for issue #2623 splits into four layers. Each layer is one
pull request on top of the layer before it.

- **L1, `scanner-offline-api`**: the server side. The scan-token endpoints
  answer SHA-256 digests only, and the scan endpoints accept a `token_hash` in
  the door's own scope.
- **L2, `scanner-offline-store`**: the door's device storage. This layer, and
  the subject of this document.
- **L3, `scanner-offline-mode`**: the scanner page's offline mode. It loads
  the saved list, answers scans from it, queues offline check-ins, shows the
  offline state, and replays the queue when the connection returns.
- **L4, `scanner-offline-pwa`**: the service worker. It saves the scanner page
  and its bundle, so the page reloads with no connection.

The feature is not complete until L3 and L4 land. The Cucumber scenarios for
the offline door land with the page layers, because the door's journeys need
the page.

## What the storage layer holds

The layer is `src/ui/client/scanner-door-store.ts` with
`src/ui/client/stored-array.ts`. The code is a set of pure functions over a
localStorage-shaped key-value store. No page calls it yet. L3 adds the page
wiring.

The store holds three things for one door:

- The **saved list**: the door's ticket digests with the moment the door saved
  them. `saveHashList` writes it. `savedHashList` reads it back.
- The **queue**: the check-ins that wait to send, oldest first. Each queued
  check-in holds its digest, its delivery id, and the moment the device
  queued it, under its own storage key. `queueCheckIn` adds a check-in once
  and mints its delivery id, so a double scan cannot queue one ticket twice.
  `dropQueuedCheckIn` removes one digest.
- The **switch**: the stored state of the manual offline switch.
  `setOfflineMode` stores it. An absent value means off.

The slot names carry the door's scope, a listing or a group, with its id. Two
doors never share a saved list, a queue, or a switch.

## The queue's one rule

A check-in leaves the queue only after the server answered that check-in for
good. A page reload, a failed send, or an answer the page cannot read leaves
the check-in queued. The queue therefore loses no pending work. The replay
run in L3 calls `dropQueuedCheckIn`, and only on a definitive scan answer.

Each queued check-in lives under its own storage key, named after its
delivery id. A queue write touches only its own key. Two page visits on one
device therefore never overwrite each other's queued check-in.

Two visits can still queue one ticket when both scans land inside the same
moment. The server admits nobody twice: the second delivery answers
`already_checked_in`, and L3 shows that answer to the user, per queued
check-in.

Each queued check-in carries the delivery id the device minted at queue time.
The replay sends that id as the scan request's `operation_id`. The server
stores the id, so one lost answer admits nothing twice.

## The 12-hour limit

A saved list answers scans for 12 hours from the moment the door saved it.
`savedHashList` deletes a list past its 12 hours, so the device keeps no
digests past their use. The next online load replaces the list whole. The
expiry touches the saved list only. A queued check-in waits until its replay,
however old the saved list is.

## Privacy and security risks

The device stores digests only. A digest is a SHA-256 hash of a ticket token.
The store never holds a raw ticket token or a guest detail, in the saved
list, in the queue, or in the switch.

The risks that remain:

- A digest admits its ticket at the door API when the caller also holds the
  door's own access. A lost device with an open door session can check the
  door's tickets in without the tickets. The digests reveal no ticket details
  and no guest details.
- The delivery id is a random string. It carries no guest detail and names no
  ticket.
- Any script on the site's origin can read the site's storage on the device.
  This is true of every browser store, and it holds the digests here.
- The saved list sits on the device for up to 12 hours. The expiry deletes
  it. The door also replaces it on the next online load. The queue and the
  switch stay until the door sends the queue or the user clears the site's
  storage in the browser.
- Two offline doors can accept one ticket before either door syncs. The
  server cannot stop that. It admits nobody twice: the second check-in
  answers `already_checked_in` without a second admission. L3 must show that
  answer to the door's user, per queued check-in.
