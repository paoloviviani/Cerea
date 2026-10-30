# Notifications

Cerea can tell you when something needs you or has finished, even with the tab
closed: a notification on your phone or desktop. It uses **Web Push**, the
standard browsers and installed web apps share, so there is nothing to install
beyond Cerea itself.

It is **off until you turn it on**, one device at a time, and you choose which
events you hear about.

## Turning it on

Open **Settings → Notifications** and press **Turn on** on the device you want
notified. Your browser asks for permission then, and only then. Do it again on
each browser or installed app you want: every one shows up under **Your
devices**, where you can remove it. **Send a test notification** checks the
whole path.

If the page says notifications are not set up, the deployment has no push keys
yet; see [For operators](#for-operators).

### On an iPhone or iPad

Safari delivers push only to an app added to the Home Screen (iOS 16.4 or
later). Tap **Share**, then **Add to Home Screen**, open Cerea from there, and
turn notifications on in that app. In a plain Safari tab the Settings page
tells you this instead of offering a button that cannot work.

### If the browser has blocked them

Once you refuse the permission prompt the browser remembers. Allow
notifications for the site in the browser's own site settings, then come back.

## What you can be told about

| Event                           | When                                                                                                                                                                                    | Default |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **An agent needs you**          | A coding agent asks for an approval or has a question. The same cards as the _Needs you_ inbox.                                                                                         | on      |
| **A long agent turn finishes**  | A coding agent worked for more than a minute and a half and stopped (with an error, if it failed).                                                                                      | on      |
| **A scheduled run finishes**    | A [scheduled action](code-panel.md) ran to its end, failed, or could not start because the machine was offline. A [scheduled chat](chat.md#scheduled-chats) says it answered or failed. | on      |
| **A background task fails**     | A task an agent started in the background ended with an error.                                                                                                                          | on      |
| **A long chat answer is ready** | A chat reply that took more than a minute and a half completed.                                                                                                                         | off     |

The switches apply to all your devices.

Two things worth knowing:

- **You are not told while you are looking.** If a window of Cerea is open,
  visible and focused, the notification is skipped, since the app already shows
  it. The check is made in your browser, which is the only place that knows.
  The test notification is always shown.
- **A stopped run is not a failure.** Cancelling a session cancels its
  background tasks; that is not reported.

A person is sent at most twelve notifications in five minutes, so a loop of
approvals cannot flood a phone.

## What a notification contains

A title, one short line, and where to open. Never what the agent said, the
command it wants to run, a file name or a prompt: the push service relays the
message (encrypted) and a lock screen shows it to whoever holds the phone, so the
detail stays behind your sign-in. Tapping it opens the app at the right place.

## For operators

Push needs a key pair (VAPID, RFC 8292) that identifies this deployment to the
push services. On the deploy kit `./configure` creates it **once** and writes
`CHAT_VAPID_PUBLIC_KEY`, `CHAT_VAPID_PRIVATE_KEY` and `CHAT_VAPID_SUBJECT` to
`.env`; an upgrade that re-runs it never replaces an existing pair, because a
new pair strands every subscribed browser (each person would have to turn
notifications on again). An install from before this feature gets the pair the
next time you run `./configure`, then `docker compose up -d`.

Without the keys the feature is off everywhere and Settings says so. A pair
whose halves do not match is treated the same way, and `./configure --check`
warns about it. Back the keys up with the rest of `.env`.

Outside the kit, set the three variables ([Configuration](configuration.md#notifications)).
Generate a pair with any ES256/P-256 tool; both halves are base64url without
padding, the public one the 65-byte uncompressed point.

- Each device's address at its push service is a capability, so the app stores
  it with the person, never shows it back, and sends only to `https` addresses
  that resolve to a public address (no private, loopback or link-local ranges,
  checked again when connecting).
- A push service that answers 404 or 410 has dropped the subscription, and it is
  removed. Other failures are logged with the service's host and status, never
  the address.
- Subscriptions are erased with the account and move with it on a merge.
- Your server needs to reach the browsers' push services (Google's, Mozilla's,
  Apple's, Microsoft's) over https on port 443.
