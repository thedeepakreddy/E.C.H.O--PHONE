# Echo Remote

Echo's standalone phone assistant, with an optional relay connection to Echo on your Mac over Wi-Fi or mobile data.

```
iPhone (Home Screen app) ──https──▶ echo-remote on Render ◀──https long-poll── Echo on your Mac
```

Your Mac never opens a port. Echo keeps a few outgoing requests open to the relay. The relay hands each phone request to Echo, and Echo answers it.

Mac control requires pairing: the link token, password, Mac sessions and Face ID are verified by Echo on the Mac. For that connection, the relay is a mailbox:

- It holds a phone request until Echo collects it.
- It caps password guessing per address.
- It serves the app's own files.

Separately, it fetches the World page from [Osiris](https://osirisai.live), plus weather and city search from Open-Meteo. None of that touches Echo.

## Deploy (once)

1. **Make a secret.** In Terminal on your Mac, run:

   ```bash
   openssl rand -hex 32
   ```

   Keep the output handy. This server secret signs phone sessions and encrypts stored data. If you connect Echo Mac, it also authenticates the relay connection. No Mac is required to deploy or use Phone mode.

2. **Push this folder to GitHub.** Use a private repo if you like; Render can read either.

3. **Create the service on Render.**
   1. Go to **New → Blueprint** and pick the repo. `render.yaml` sets up a free Node web service called `echo-phone`.
   2. Under the service's **Environment**, add `RELAY_SECRET` with the secret from step 1.
   3. Wait for the deploy to finish. Opening `https://<your-service>.onrender.com/healthz` should show `{"ok":true,"echo":"offline"}`. Until the secret is set, it shows `"unpaired"`.

4. **Optional: connect Echo on your Mac.** Skip this for standalone Phone mode.
   1. In Echo's **API keys**, set **Echo phone app** to the same secret.
   2. In `~/.jarvis/config.json`, set:

      ```json
      "remote": { "alwaysOn": true, "relayUrl": "https://<your-service>.onrender.com" }
      ```

   3. Restart Echo. `/healthz` now says `"echo":"online"`.

5. **Install it on your iPhone.**
   1. Open the app's address in **Safari** (or Chrome) and tap **Share → Add to Home Screen**.
   2. Open **Echo** from the Home Screen and tap **Get started**.
   3. **Optional:** go to **Settings → Your Mac**: ask Echo on the Mac to *show the phone remote link* and tap **Scan the QR code** (or paste the link from Telegram's **/link**), then sign in with your remote password, or turn on **Unlock with Face ID**.

The first screen is only **Get started**; everything about the Mac lives in **Settings → Your Mac**. Get started opens Phone mode directly, with a server-issued session that renews without a Mac. Pairing is optional and lives under Settings → Your Mac. Only links for this app's own address are accepted. The QR reader is [jsQR](https://github.com/cozmo/jsQR) (Apache 2.0), served from `public/vendor`.

The link carries a private token. Treat it like a key, and don't post it anywhere.

## What's in the app

| Tab | What it does |
| --- | --- |
| **Echo** | Voice, a humanoid that reacts to conversation, weather, live state and one dismissible question based on a saved note. Reduced motion keeps the figure visible without extra animation. |
| **Today** | Tasks, reminders, upcoming bills and the latest calendar snapshot. Capture naturally, add an exact time, mark an occurrence Done, or Snooze it. Daily, weekdays, selected weekly days and monthly recurrence preserve local wall time. |
| **Chat** | Synced Phone conversations, text and voice. Tap the title for folders or + for a new conversation. Echo organizes a clear topic automatically; users can move or rename it. |
| **Saved** | Searchable notes, documents, receipts and dates. Echo retrieves saved facts, earlier Phone conversations and commitments with links back to their sources. |
| **More** | Echo's Browser, optional Mac missions, World, photo/document help, account recovery and Settings. |

Replies to anything sent from the phone come back to the phone only. Echo doesn't say them out loud on the Mac.

On Phone, tap Listen or either humanoid once to start a continuous voice conversation. A 1.4-second speech pause sends each turn, Echo reads the reply, then listens again. Tap Pause/Stop to end it. Voice also stops when you leave Echo/Chat, hide the app, change accounts or modes, or the microphone is interrupted. The composer still supports hold-to-record voice notes. The Mac's recording protocol is unchanged.

## Phone mode

Tap the pill at the top right of the Echo page to choose where Echo runs:
- **Mac:** Echo on your Mac, as above.
- **Phone:** Echo in the cloud, on this relay with Gemini. It answers, searches, recalls saved context and captures authorized tasks and reminders directly in Today. Calendar, Shortcuts and Mac jobs still have explicit action buttons. A delegated web task starts Echo's Browser automatically, which retains its approval checks before consequential actions. It keeps working while the Mac is off.

**How it's protected.** Get started creates a random account identity and a signed 30-day session, renewed by this server. Supplying a device id cannot restore it. More → Your Echo account creates a random 256-bit recovery key; only its hash mapping is stored. Save the key privately before clearing browser storage or changing phones. Restoring on another installation syncs Phone conversations, folders, tasks, memory and scans through encrypted Upstash storage, and always issues Phone-only privileges. Key rotation invalidates the old key; already signed-in installations stay connected. Mac authentication, browser cookies and Mac chat history are not restored. Standalone sessions cannot read the Mac's digest, submit Mac jobs or revoke its paired phones. Optional Mac sign-in adds a paired pass for the same identity. Each installation has its own notification subscription; paired and Phone-only briefings are stored and delivered separately. Recovery is unavailable on an ephemeral memory store.

**Messages sync.** Phone conversations use server history and bounded encrypted threads, with idempotent turn IDs. Older local Phone messages migrate once per installation; Mac messages stay outside that migration. Phone messages also copy into a signed-in Mac's chat when it returns, using stable IDs to avoid duplicates.

**Natural capture and help.** “Don't let me forget to call Mum every weekday at 9” creates a recurring reminder immediately. “Remember my passport renewal idea” saves a note. “What did we decide?” searches the second brain. “Help me handle this” on a scan prepares a practical next step or draft. “Do this for me” delegates supported web work. Echo cannot pay a bill or send a message merely by marking a task Done, and it says when a requested integration is unavailable.

To set it up, add these to the service's **Environment** on Render:

| Variable | What it's for |
| --- | --- |
| `GEMINI_API_KEY` | The cloud brain. Use a key from its own Google AI Studio project; the free tier is fine. Set `GEMINI_MODEL` to change the model. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Durable, encrypted storage on Upstash's free plan. Without them, the relay forgets everything when Render restarts. |
| `QSTASH_TOKEN` | A wake-up every 5 minutes from Upstash QStash, so the relay stays awake and timed features can run. Also set `QSTASH_URL` if the Upstash console shows one. |

`/healthz` shows whether Phone mode's brain and storage are set up.

### Morning briefing and reminders

Turn on **Settings → Morning briefing → Briefing and reminders** in the Home Screen app, and allow notifications when asked.

- **The briefing** arrives at the time you choose, on the days you choose. It has:
  - weather for your saved location
  - today's calendar and unread email that needs you, from the summary Echo on the Mac leaves hourly, so it works even with the Mac off
  - earthquakes and storms within reach
  - what the Mac finished overnight
  - today's reminders

  **Brief me** builds it on demand.
- **Reminders** are captured directly in Today, including recurrence. Allow notifications in Today for background alerts; this does not require turning on a daily briefing. Without OS permission the items remain in Today, and Echo never guarantees push delivery. Done completes one occurrence; Snooze changes only that occurrence, even when the user changes time zones. Notification delivery does not complete a task. The scheduler catches up once per recurring series and retries failed deliveries.
- **Calendar from this iPhone:** a web app can't read the iPhone's calendar, so a one-time Shortcut automation posts today's events to a private link each morning. Find it in Settings → Morning briefing → Calendar from this iPhone, which has step-by-step instructions.
  - The link can only add today's events for this phone's briefing, and **Make a new link** retires the old one.
  - The briefing prefers that morning's events from the iPhone, and uses the Mac's summary otherwise.

Notifications are encrypted end to end (Web Push, RFC 8291). The relay's notification key is derived from `RELAY_SECRET`, so there's nothing extra to configure. Timed work runs every minute while the relay is awake, and QStash wakes it every 5 minutes while the Mac is off.

### Snap & act

Tap **Snap** on Home (in Phone mode) or the camera in Chat. Take or choose a photo of a bill, receipt, ticket, letter, document (an ID, insurance, warranty or contract), menu or price tag. Echo reads it in one request and shows what it found; you can correct any field. The buttons depend on what it is:

| Photo | Buttons |
| --- | --- |
| Bill | Remind me 2 days before it's due · Add the due date to Calendar · Save as expense |
| Receipt | Save as expense |
| Event | Add to Calendar · Remind me the day before |
| Letter | A reminder before its deadline · What do I need to do? · File it on my Mac |
| Document | What should I know? |
| Product | Find it cheaper |

Foreign-language text comes with an English translation. Expenses add up by month on the Snap page.

**Your scans:** every readable scan is kept in its history, without the photo. That's what Echo found, your corrections, and which buttons you used. Tap one to reopen it with its buttons, or delete it.

How it's kept safe:
- The photo is shrunk on the phone (which drops its location data), sent for that one read, and never stored.
- The buttons are made from the checked fields, never from text in the photo.
- Snap has its own daily cap: `PHONE_DAILY_SNAPS`, default 30.

### Saved: Echo's memory

**Save to memory** on any scan (new or from its history) keeps what Echo found, never the photo. **+** on the Saved page, or tapping a chat message and **Remember**, saves a note in your own words. In Phone mode, "remember that…" saves one too.

- **Saved page** (Snap → Saved): everything grouped as Bills, Documents, Receipts, Events and Notes, with search. Open an item to rename it, edit a note, add or remove dates, mute its reminders, ask Echo about it, or delete it.
- **Echo remembers:** in Phone mode Echo searches your saved items before saying it doesn't know something personal ("when does my car insurance renew?"). Search works by meaning, not exact words. Each item gets a vector from Gemini's embedding model (`gemini-embedding-001`, its own free quota; `GEMINI_EMBED_MODEL` changes it). Items saved while embedding is unavailable are found by their words, and get their vectors on a later search.
- **Dates:** every date in a saved item (a due date, an expiry, a renewal, an appointment) is reminded 7 days and 1 day before, at 9:00 your time, by notification. The briefing gets a **Coming up** card for the next two weeks.

Saved items are sealed with the relay's key like everything else in the store: an index (titles, dates, vectors) and each item's content under its own key. Up to 250 items per phone; the oldest go first.

### Browser

The **Browser** tab is a web browser inside Echo Phone that you and Echo share. Settings moved to the Echo page, where the Brain button was; Brain is in Settings.

- **You browse:** type an address or a search (Bing: DuckDuckGo doesn't answer servers like the relay). Back, forward, reload, and **⋯** for Open the real page (Safari from a Home Screen app, a new tab in Chrome or Safari), Copy address, and Sign out of all websites.
- **Hand it to Echo:** type what's left in **Ask Echo to do something here**, for example "finish this form, but stop before sending" or "compare these three laptops". Echo works in the same tab while you watch, one step at a time. **Take over** stops it at once. When it's done, the answer shows under the page and in Chat.
- **Big jobs from Chat:** in Phone mode, ask for something that needs real browsing and Echo offers **Let Echo browse this**.
- **How Echo does a task:**
  1. **Plan.** The task becomes 3–8 concrete steps, each with how to tell it's done. The checklist shows above the box.
  2. **Steps, one at a time.** Echo reads the page as text with every link, button and field numbered (browser-use's method) and takes one action at a time: click, type, choose, open, search, go back, read further, ask you. It keeps a running memory and notes, and marks a step done only with its result. A failed try starts the step again from where it began, up to 3 tries; doing the same thing three times without progress counts as a failed try.
  3. **Report.** At the end, a report from every step's result and the notes: the answer, the findings with links, and anything not done. It's copied to Chat.
- **Human in the loop.** When Echo needs a choice or a detail, or a step failed 3 times (Try again / Skip it / Stop and report, or type what to do), it asks and waits a minute. With no answer it decides by itself (a stuck step is skipped) and carries on. Risky steps (pay, book, send, submit, delete) are the exception: with no Go ahead within a minute, they aren't done.
- **Gemini's free tier.** Browsing uses the two strongest Flash models the key can use, in turn (found at startup, or `GEMINI_BROWSE_MODEL`, comma-separated), each with its own free quota; one that's busy or overloaded rests a minute or two, and Phone mode's own model answers when both are.
- **Sites that refuse.** Some sites block servers like the relay (TripAdvisor answers 403, Google 429). The page says so, Echo is told which sites refused and doesn't open them again in that task, and search results from them are marked. Echo gets 3 searches per try of a step, then opens a result. A "too many this minute" is waited out with a countdown, as long as Google says. If it still fails, **Retry** carries on from the step it reached; **Take over** stops at once, and **Continue** picks up from the same step. `PHONE_DAILY_BROWSE` caps requests per day (default 300).

How it's kept safe:
- **Pages can't run anything.** The relay fetches each page and removes its scripts. Every link, form, image and stylesheet is rewritten to go back through the relay. The page is then served with a policy that forbids scripts, into a frame sandboxed without scripts. That is what lets the app read and click the page for Echo. Images, fonts and stylesheets are the only other files it will pass on.
- **Public sites only.** The relay never fetches loopback, private-network or cloud-metadata addresses, whatever a page or redirect asks, and checks each address after looking it up.
- **Your approval.** Echo stops for Go ahead / Don't before anything that pays, buys, books, sends, submits a form to a site, signs up, deletes or changes settings. No answer means no.
- **No secrets typed by Echo.** Echo never types into password, card, security-code or ID fields; it asks you to. Bank and payment sign-ins aren't carried at all: use your normal browser for those.
- **Page text is information.** Whatever a page says, Echo doesn't take instructions from it.
- **Sessions:** the sites you sign in to keep their cookies per phone, sealed in the store for 30 days. **Sign out of all websites** clears them. **Sign out every phone** also ends the Browser's own session.

What doesn't work: sites that only run with their scripts (web apps, maps, many checkouts) show little or nothing. Use **⋯ → Open the real page** for those. Searches come from the relay's server, so some sites may show it bot checks.

### Hand-off to the Mac

Jobs that need the Mac can wait for it:
- **Leaving one:** use **Missions → Waiting for your Mac → New job**, or tap **Do this on my Mac** in Phone mode while the Mac is off.
- **Approving it:** Face ID approves the job's exact text. The passkey signs a hash of the job.
- **Running it:** the next time Echo is on, it checks that signature against the Face ID key the phone registered. A job that's edited, forged, over a week old or already run is refused. A good job runs as an ordinary Echo chat turn, so Echo's own safety approvals still apply.
- **Order:** jobs run one at a time, oldest first, only while Echo is idle.
- **Status:** each job shows as Waiting, Working, Done, Failed or Refused. A notification arrives when it finishes.

The relay only holds jobs and can't check Face ID itself; the Mac checks it before running anything. At most 10 jobs wait at once.

## Notes

- **Free plan.** Render's free services sleep after 15 minutes without traffic. While Echo runs, its polling keeps the relay awake. If the Mac has been off, the first open takes about a minute while Render wakes up. One always-on service uses about 744 of the 750 free hours a month.
- **Updates.** Push to GitHub and Render redeploys. The app picks up the new version the next time it opens.
- **Tests.**

  ```bash
  npm test
  ```

- **Run locally.**

  ```bash
  RELAY_SECRET=<32+ chars> npm start
  ```

  Then set `relayUrl` to `http://127.0.0.1:10000`. Face ID needs the real https address.
