# Echo Phone: a connected daily assistant

## Full particle speech
Display the entire spoken reply as short, readable particle phrases. Split without dropping words; queue each phrase in the same selected voice and use native utterance start/end events to select its particle text. Keep the burst active until the complete reply ends, so no timer switches to ordinary captions. Retain the full written reply in Chat and an accessible transcript. Cancellation, errors, hidden-app cleanup and replacement replies invalidate all queued utterance callbacks. The final phrase briefly remains before the humanoid reforms; Stop reforms it immediately. Reduced motion uses static particle words. Test all phrases, long words, speech queue completion, errors and cancellation, then verify mobile canvas rendering and deploy.

## Continuous voice follow-up

Tapping either humanoid shares the Listen action, including a keyboard-accessible button and active state. Preserve the newly rendered launcher icons and icon cache versions. Restore the pre-logo idle Home layout by keeping the unfinished voice status markup hidden until a voice session starts; no visual redesign or humanoid animation replacement.
On Phone, Listen and the Chat header voice button start one foreground conversation. A speech pause sends the turn; capture stays gated while the request and spoken reply complete, then resumes automatically. No new setting is required. Keep hold-to-record notes and the Mac's existing recording flow. Show listening/thinking/speaking and a clear stop control. Stop, leaving the app, account/mode changes and microphone interruption release capture and invalidate pending turns. Silence never creates a request. Cap each utterance below the existing voice limit. Use the current microphone/PCM pipeline rather than browser speech recognition, with testable speech segmentation and session lifecycle. Verify synthetic audio, permission races, cancellation, spoken-reply completion and mobile layout before pushing and deploying.

## Experience
Five destinations: Echo (voice and a responsive humanoid), Today (commitments and dates), Chat (conversations organized in folders), Saved (searchable personal memory), More (browser, Mac missions, world, settings, recovery). Keep the existing home-indicator spacing and optional Mac connection.

Conversation is the main input. Explicit requests to remember a fact save memory; explicit commitments create tasks, bills or reminders immediately. Ask for a missing or ambiguous date rather than guessing. Scheduling works without notification permission; show the permission request in Today when useful. Recurring reminders use the user's time zone and preserve their local time across daylight saving changes. Done completes an occurrence; Snooze moves only that occurrence.

“Help me handle this” prepares an actionable response using saved context and the user's document/photo. “Do this for me” routes supported web work to the existing browser agent; purchases, sending, deletion and submissions retain the browser's approval checks. Unsupported integrations must be stated honestly. Successful captures appear as linked receipts under the reply, with no activation toggle.

Echo's voice is attentive, concise and gently witty when appropriate. The humanoid responds to listening, thinking, questions and completed captures, respects reduced motion, and does not infer feelings. A single dismissible question on the Echo page draws from actual saved context. No unsolicited notifications for curiosity.

## Data and security
Use the existing encrypted Upstash store; no new service or paid dependency. Account recovery uses a randomly generated recovery key, stored only as a hash mapping; key rotation invalidates the previous key. Recovery issues Phone-only privileges and never restores Mac authentication. Shared data includes phone conversations, folders, memory, scans and daily items. Existing local Phone chats migrate idempotently; Mac chats remain outside this sync. Each installation has a separate notification identity; subscriptions cannot reveal a paired Mac digest to recovered Phone-only sessions.

Bound all collections, validate every write on the server, serialize read/change/write, deduplicate chat turns and captures, and return useful errors. Never mark a task done merely because its notification was delivered. External calendar events remain read-only; an explicit user task can be created from them. Preserve stale calendar timestamps so users can tell whether their Shortcut has refreshed.

## Vertical slices and verification
1. Daily data and recurrence (`lib/daily.js`, relay, tick): CRUD, Done/Snooze, recurrence, saved bill dates, calendar aggregation. Test DST, month ends, retries, notification failure and account isolation.
2. Recovery and conversations (`lib/conversations.js`, relay): recovery/rotation, bounded threads/folders, idempotent migration, sync and server history. Test key invalidation, unauthenticated access and Phone-only recovery.
3. Conversation intelligence (`lib/cloud.js`): durable commitment tools, second-brain retrieval with references, personality, expression and supported delegation. Test successful and failed tool receipts, no unsupported claims and tool authorization scope.
4. Phone interface (`public/experience.js`, app, HTML/CSS): five tabs, Today capture and actions, Saved search, conversation drawer, recovery, curiosity. Check 375×667 and 390×844 layouts, keyboard/sheets, empty/error states and live recovery between installations.
5. Humanoid reactions and release: integrate reduced-motion-safe expressions, update offline shell, run the complete regression suite and browser flow, commit and push GitHub main, trigger Render deployment and verify live version/health.

## Constraints
Phone calendar access uses the existing iOS Shortcut and shows setup guidance when disconnected. Notifications require the platform's permission; never promise a push when it is unavailable. Durable recovery/sync requires the configured Upstash store and is presented as unavailable on an ephemeral local store. Keep all code and release text free of chat/session links.
