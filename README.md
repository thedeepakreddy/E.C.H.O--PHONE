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
