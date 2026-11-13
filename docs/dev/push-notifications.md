# Push notifications (Web Push)

User page: `docs/notifications.md`. Code: `src/lib/server/push/`, `src/lib/pushWorker.ts`
and `src/service-worker.ts`, the Settings screen
`src/lib/components/settings/NotificationSettings.svelte`.

- **`web-push` builds the request, we send it.** `push/webpush.ts` calls
  `webpush.generateRequestDetails` (VAPID ES256 JWT, RFC 8291 aes128gcm) and
  never `sendNotification`. The send goes through `push/guard.ts`: https only,
  no private or internal destination (10/8 included, unlike the shared
  `urlSafety`), checked on the resolved address, redirects not followed. The
  RFC 8291 appendix A vector is decrypted in `webpush.spec.ts`; the package is
  MPL-2.0, unmodified, listed in NOTICE.
- **Off unless the keys are a pair.** `vapid.ts` returns null for unset keys, a
  wrong-length key, a public key that is not the private key's, or a subject
  that is not `mailto:`/`https:`; the API then reports `configured: false`, and
  Settings says so. The kit's `./configure` mints the pair once
  (`CHAT_VAPID_*`, pure-Python P-256 in `kit/configure`, never re-minted:
  a new pair strands every subscribed browser).
- **Where events come from** (`push/watch.ts`; every trigger is wrapped in
  `safely`, a push never breaks what it reports):
  - the machine link calls `observeMachineEvent` for every event frame
    **before** its "nobody is watching" return (a person with no tab open is who
    needs it): `permission.asked`/`question.asked` → `permission`; busy→idle on a
    root session after `LONG_TURN_MS` → `agentTurn`; a synthetic background-task
    part in state `error` → `backgroundTask`;
  - the scheduler's `record()` calls `afterScheduleRun`: a failed or missed
    dispatch is told at once, a `sent` one registers the session so the end of its
    turn is the run's end (one notification, not also `agentTurn`);
  - the generation writer's `finish` calls `chatTurnFinished` (default off).
    The in-memory turn and ask bookkeeping is bounded and lost on restart: that
    loses a notification, never sends a wrong one.
- **Cancelled background tasks (G8) are not an event**: galopin tells the parent
  agent, not the server, and a Stop is the person's own act.
- **Payload is thin and not sensitive** (`notify.ts`): title, one line, a path
  under the base, an icon. No message text, command, tool argument or prompt.
  Add a new event as an entry in `utils/pushEvents.ts` plus its trigger; the
  copy goes through `buildPayload`.
- **The focus check lives in the service worker**, because only the browser
  knows: `shouldShow` skips the notification when a window is visible and
  focused (the test notification always shows). The worker has no `fetch`
  handler and no cache, so registering it changes nothing about loading;
  SvelteKit registers `src/service-worker.ts` at `<base>/service-worker.js`.
- **Storage**: `pushSubscriptions` (unique `endpoint`, owner `userId`), in
  `identity/userKeyedCollections.ts` and the roster in its spec. The endpoint
  and keys never leave the server (`deviceView` sends a label, dates and a
  16-hex fingerprint the browser matches against its own endpoint). Per-event
  switches are `Settings.pushEvents`, written only by `PATCH /api/v2/push`: the
  general settings routes post a whole copy loaded at page open and would
  overwrite a toggle made since.
