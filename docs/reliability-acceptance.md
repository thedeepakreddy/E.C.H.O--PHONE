# Reliability acceptance — local October 15 work

This is a local repair record, not deployed Render or physical-iPhone proof.
Review these changes before publishing either repository.

Final local result: guarded `npm run ci:offline` passed 240/240 tests. Selected
Office, agent Retry, compiler-report Retry and trackpad Chromium fixtures passed.
The trackpad runner covered nine scenarios without network or console errors.
The live Render version was not changed or certified by these results.

## Relay ownership

The 64-request admission budget includes bodies still arriving, queued commands
and requests the Mac has collected but not answered. Admission is reserved
synchronously before reading the body. One deadline covers body upload and the
remaining round trip. Reply, timeout, body error, oversized input, Phone
disconnect and Mac disconnect release the reservation exactly once. A request
that lost ownership cannot enter the queue when its body eventually finishes.

Clean bot status reads evaluate the storage save predicate after the read;
actual state cleanup is persisted, unchanged polls do not rewrite encrypted
storage. This does not remove authentication or storage leases.

## Commands and checks

`npm test`, `npm run test:offline` and `npm run ci:offline` use the same bounded
offline runner, with remote network access blocked in child processes. Filters
and `--list` are supported. Phone has no separate compilation step; this gate
exercises its server, shipped scripts and injected integrations.

`npm run test:ui -- --list` lists six isolated browser fixture suites. Select
`office`, `retry`, `reportretry` or `trackpad` to run those checks with an installed
Playwright/Chromium runtime. The runner does not install/download browsers, invoke
real Mac input or certify physical iPhone touch behavior. Unknown options, empty
selections and UI-registry drift fail rather than silently losing coverage.

Update delivery preserves command IDs and ordered durable receipts. Distinct
annual → monthly → annual commands all apply; a repeated acknowledgment cannot
reapply one command. Legacy ambiguous delivery is reported instead of guessed.
Failed checkpoint/storage/heartbeat operations revoke the worker before more
effects. User Stop, time budget and lost lease retain their own meanings. An
uncertain prior write remains a Retry blocker.

Cancelled gestures and capture loss discard unsent movement, pending tap/flush
timers and tap history. Other pointer IDs cannot take ownership. A gesture already
sent to the Mac cannot be undone by cancelling a later browser event.

## Acceptance boundaries

- Offline tests use injected model responses and disposable local servers.
- Browser checks use isolated profiles and fixture Mac endpoints, never real
  mouse/keyboard calls or personal browser sessions.
- Real Mac LCU, audio, Stop and multi-display behavior require a separate
  approved device test.
- Physical iPhone gestures and the deployed Render revision/configuration
  require acceptance after user review and deployment authorization.
