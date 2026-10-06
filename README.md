# Echo Remote

Echo's phone app, and the small relay that connects it to Echo on your Mac from any network, on Wi-Fi or mobile data.

```
iPhone (Home Screen app) ──https──▶ echo-remote on Render ◀──https long-poll── Echo on your Mac
```

Your Mac never opens a port. Echo keeps a few outgoing requests open to the relay. The relay hands each phone request to Echo, and Echo answers it.

The relay checks nothing about you and stores nothing about you. The link token, your password, the sessions and Face ID are all verified by Echo on the Mac. The relay is only a mailbox:

- It holds a phone request until Echo collects it.
- It caps password guessing per address.
- It serves the app's own files.

Separately, it fetches the World page from [Osiris](https://osirisai.live), plus weather and city search from Open-Meteo. None of that touches Echo.

## Deploy (once)

1. **Make a secret.** In Terminal on your Mac, run:

   ```bash
   openssl rand -hex 32
   ```

   Keep the output handy. It's the password between the relay and Echo.

2. **Push this folder to GitHub.** Use a private repo if you like; Render can read either.

3. **Create the service on Render.**
   1. Go to **New → Blueprint** and pick the repo. `render.yaml` sets up a free Node web service called `echo-phone`.
   2. Under the service's **Environment**, add `RELAY_SECRET` with the secret from step 1.
   3. Wait for the deploy to finish. Opening `https://<your-service>.onrender.com/healthz` should show `{"ok":true,"echo":"offline"}`. Until the secret is set, it shows `"unpaired"`.

4. **Tell Echo about it**, on the Mac:
   1. In Echo's **API keys**, set **Echo phone app** to the same secret.
   2. In `~/.jarvis/config.json`, set:

      ```json
      "remote": { "alwaysOn": true, "relayUrl": "https://<your-service>.onrender.com" }
      ```

   3. Restart Echo. `/healthz` now says `"echo":"online"`.

5. **Install it on your iPhone.**
   1. Send **/link** to Echo on Telegram.
   2. Open the link in **Safari** and sign in with your remote password.
   3. Tap **Share → Add to Home Screen**.
   4. Open **Echo** from the Home Screen, then turn on **Settings → Unlock with Face ID**.

The link carries a private token. Treat it like a key, and don't post it anywhere.

## What's in the app

| Tab | What it does |
| --- | --- |
| **Echo** | Live state, brain, Listen (talk to Echo; the answer is read out on the phone), Stop, Screen, Brain, Neural map, weather, today's numbers, and approvals when Echo needs your OK. |
| **Chat** | A personal conversation with Echo, like Telegram. Text or hold-to-record voice notes; Whisper transcribes them on the Mac. |
| **Missions** | Running missions with live steps, plus agents and coding projects. A mission's Stop button needs a second tap to confirm. |
| **World** | Live conflict zones, earthquakes, wildfires, tsunami flags and storms from Osiris. |
| **Settings** | Brain switch, Echo's voice switches, Face ID, reading replies aloud on the phone, sign out, and **Power off**, which always asks for Face ID. |

Replies to anything sent from the phone come back to the phone only. Echo doesn't say them out loud on the Mac.

## Phone mode

Tap the pill at the top right of the Echo page to choose where Echo runs:
- **Mac:** Echo on your Mac, as above.
- **Phone:** Echo in the cloud, on this relay with Gemini. It answers, searches the web, checks weather and world events, and offers buttons you tap: add to calendar, remind me, run a Shortcut, open a link, or send a job to the Mac. It keeps working while the Mac is off. It can't reach the Mac itself.

**How it's protected.** The Mac signs a cloud pass for the phone when you sign in. The pass is valid for 30 days and renews while the Mac is reachable. *Sign out every phone* cancels every pass, from either the Mac or the phone. Everything the relay stores is encrypted with a key derived from `RELAY_SECRET`.

**Messages sync.** Phone mode's messages are copied into the Mac's chat when it's back, never twice.

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
- **Reminders** from Phone mode arrive as Echo notifications at their time. With notifications off, they go to Calendar through Safari instead.
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
