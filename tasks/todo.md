# Echo Phone feature checklist

## Full particle speech
- [x] Implement complete, event-driven spoken phrases and queue cleanup.
- [x] Render readable particle phrases throughout speech, including static words for reduced motion.
- [x] Verify 102 regression tests and Chromium/WebKit mobile rendering: all nine phrases, complete long-word glyphs, no caption timeout and stale-callback cancellation. Prepare release for GitHub and Render.

## Continuous voice
- [x] Add speech pause detection and a cancellable microphone session.
- [x] Integrate Home/Chat turn-taking, humanoid tap controls, spoken replies and foreground/account cleanup.
- [x] Verify 97 regression tests; Chromium and WebKit at 390×844 and 375×667; two automatic turns through native Web Audio using a synthetic microphone; normal/reduced-motion humanoid rendering.
- [x] Preserve the new launcher icons and restore the original idle layout; prepare the complete release for GitHub push and matching Render deployment verification.

- [x] Inspect architecture and integrate newer GitHub commits while preserving the local title.
- [x] Plan information architecture, automatic behavior and privacy boundaries.
- [x] Implement daily items and recurring scheduling.
- [x] Implement recovery, folders and conversation sync.
- [x] Add conversation capture, second-brain retrieval, personality and delegation.
- [x] Build Today, Saved, More and conversation/recovery interfaces.
- [x] Add contextual curiosity and humanoid reactions.
- [x] Run regression and mobile browser verification (including full-cache migration and per-installation notifications; 390×844 and 375×667 capture, folders, recovery/sync and sign-out; normal and reduced-motion humanoid).
- [x] Commit, push, deploy and verify the live feature release (`644b418`, Render `dep-db43oprbc2fs73agi770`, app `94ae1fe1f472`): real Gemini weekly capture and recovery against durable Upstash succeeded. Follow-up hardening preserves large legacy caches and each phone's notification setup.
