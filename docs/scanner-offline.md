# The offline scanner's door layers

The offline scanner for issue #2623 splits into four layers. Each layer is one
pull request on top of the layer before it.

- **L1, `scanner-offline-api`**: the server side. The scan-token endpoints
  answer SHA-256 digests only, and the scan endpoints accept a `token_hash` in
  the door's own scope.
- **L2, `scanner-offline-store`**: the door's device storage.
- **L3, `scanner-offline-mode`**: the scanner page's offline mode. It loads
  the saved list, answers scans from it, queues offline check-ins, shows the
  offline state, and replays the queue when the connection returns. This
  layer is the subject of this document.
- **L4, `scanner-offline-pwa`**: the service worker. It saves the scanner page
  and its bundle, so the page reloads with no connection. The feature is not
  complete until it lands: L3 still needs the connection to load the page in
  the first place, and a cold offline load is L4's claim.

The Cucumber scenarios for the offline door land with the page layers,
because the door's journeys need the page.

## What the page wiring does

The page wiring is `src/ui/client/scanner-offline.ts`, and the scanner bundle
calls it from `src/ui/client/scanner.js`. On load it reads the door's scope
from the page's token-list path and paints the stored state: the banner, the
switch, and the waiting line. While the connection is there, it fetches the
door's digest list and saves it whole, which restarts the 12 hours.

One scan goes where the switch sends it. With the switch on, the scan never
reaches the server: the page checks the token's digest against the saved
list, queues a saved ticket's check-in, and refuses an unknown one. With the
switch off, the scan settles with the server as before. A send that cannot
land — no connection, or an answer that is not a scan answer — falls back to
the saved list the same way, so a door that never touches the switch still
keeps working when the venue's connection drops.

The queue sends whenever the door proves the connection: a saved list that
arrives, an online event, a scan that lands, or the switch going back off.
One replay runs at a time. Each queued check-in sends by its digest, under
the delivery id the device made up for it. The id rides on every send of
that delivery. A retry after a lost answer claims nothing the server
already took. The same delivery twice admits once. The delivery goes
through the page's own admission flow, so the door's asks still come before
an admit. A check-in leaves the queue only after its admission finished
for good — a door answer, or the door's own skip at an ask. The first send
that cannot reach the server stops the run, and the rest stay queued.

## What the page shows

- The banner names offline mode while the switch is on.
- The switch sits beside the camera button, worded plainly, styled quietly,
  and stores its state per door.
- The waiting line counts the queued check-ins, so pending work is never
  invisible — with the switch on or off.
- Every queued check-in's replay answers on the status line by name. A
  check-in the server answers with `already_checked_in` reads "{name} was
  already checked in elsewhere.", so a second door's admission is not
  mistaken for a fresh one.
- The waiting line also names every person the last sync found was already
  checked in elsewhere, as "{count} people were already checked in
  elsewhere: {names}." It stays until the next sync replaces it whole, so
  a later status line write cannot take the story away.
- A ticket scanned twice on one device queues twice, once per delivery. A
  party's next arrival is another check-in, and the scanner's own cooldown
  takes the double press of one code. The server answers one delivery once,
  so the ticket cannot come in twice on one delivery.

## What the storage layer holds

The layer is `src/ui/client/scanner-door-store.ts` with
`src/ui/client/stored-array.ts`. The code is a set of pure functions over a
localStorage-shaped key-value store. The page wiring in
`src/ui/client/scanner-offline.ts` calls it.

The store holds three things for one door:

- The **saved list**: the door's ticket digests with the moment the door saved
  them. `saveHashList` writes it. `savedHashList` reads it back.
- The **queue**: the check-ins that wait to send, oldest first. Each queued
  check-in holds its digest, its delivery id, and the moment the device
  queued it, under its own storage key. `queueCheckIn` mints a fresh
  delivery id and queues the scan as its own check-in. A repeat scan of one
  ticket queues again: a party's next arrival is a new delivery with an id
  of its own. A double scan of one code is the scanner's own cooldown, as
  it is online. `dropQueuedCheckIn` removes one check-in, by its delivery
  id.
- The **switch**: the stored state of the manual offline switch.
  `setOfflineMode` stores it. An absent value means off.

The slot names carry the door's scope, a listing or a group, with its id. Two
doors never share a saved list, a queue, or a switch.

## The queue's one rule

A check-in leaves the queue only after its admission finished for good: a
door answer, or the door's own skip at one of the door's asks. A page reload,
a failed send, or an answer the page cannot read leaves the check-in queued.
The queue therefore loses no pending work. The page's replay run calls
`dropQueuedCheckIn`, and only on that kind of finish.

Each queued check-in lives under its own storage key, named after its
delivery id. A queue write touches only its own key. Two page visits on one
device therefore never overwrite each other's queued check-in.

One ticket can be queued twice: a party's next arrival, or two page visits.
Each queueing sends a delivery id of its own. The server guards one
delivery, not the ticket: a replayed delivery answers `already_checked_in`
and admits nobody twice, and L3 shows that answer to the user, per queued
check-in.

Each queued check-in carries the delivery id the device minted at queue time.
The replay sends that id as the scan request's `operation_id`. The server
stores the id, so one lost answer admits nothing twice.

## The 12-hour limit

A saved list answers scans for 12 hours from the moment the door saved it.
`savedHashList` deletes a list at the first read after its 12 hours. A
browser that never reads the list again can keep the stored digests
longer. The next online load replaces the list whole. The expiry touches
the saved list only. A queued check-in waits until its replay, however old
the saved list is.

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
- The saved list answers scans for up to 12 hours. The store deletes it at
  the next read after that. A browser that never reads the list again can
  keep the stored digests past their 12 hours. The door also replaces the
  list on the next online load. The queue and the switch stay until the
  door sends the queue or the user clears the site's storage in the
  browser.
- Two offline doors can accept one ticket before either door syncs. The
  server cannot stop that. It admits nobody twice: the second check-in
  answers `already_checked_in` without a second admission. The page shows
  that answer to the door's user, per queued check-in, as "{name} was already
  checked in elsewhere."
