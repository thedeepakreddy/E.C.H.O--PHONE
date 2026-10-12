# Echo agent workspace

The Bots page and the Agents → Agent office link open one workspace backed by the existing bot runner. This is a native Echo visualization inspired by the office concept in Hermes3D, not a second Hermes server or independent scheduler. The current local revision replaces photographic pixel shifting with textured, skeletal characters, fitted CC0 human meshes, inverse-kinematic hands, and physical monitor lights. It is a 3D activity projection, not a live computer-camera feed. The user requested visual review before pushing; this revision has not been published and is not claimed to match the reference's photorealism yet. No paid conversion or external reference-image upload was used.

## Interface and authority

- Office + Inspector inherits the actual host design system: Mac primary/secondary controls at 36px with 12px labels and 13px body copy; Phone glass/pill/CTA controls at 44px with 13px labels, 21px inspector headings and 16px inputs to prevent Safari zoom. Radii, layered reflections, inner rims, blur and shadows use the existing Echo recipes. The office fills the available viewport; no separate scrolling roster or permanent history panel follows it. Assign task opens the existing protected assignment dialog.
- Echo is the separate coordinator, represented by the existing particle humanoid in a non-interactive tile. The Mac `lead` task remains the internal report compiler; it is excluded from desk occupancy and specialist controls. Phone's `echo-assistant` is displayed as Assistant to distinguish it from Echo. The current Mac API exposes five specialists (plus custom agents); Phone exposes six. No new worker was invented just to make the roster count match.
- Desk labels are the sole agent-selection controls. Selecting a desk opens its inspector; Close or Escape returns to the office and restores focus to the desk. The default overview frames every actual specialist with dynamic desks (not four fixed slots). Mac reserves inspector width while keeping the roster framed; Phone reserves the measured sheet height and focuses the selected desk while inspecting, then restores the all-agent overview on close. Selection affects the label only, not body outlines or monitor lighting. Polling preserves selection and drafts. Task history, management, refresh, view fallback and motion options live in one workspace menu; history uses an on-demand dialog and closes before assignment/follow-up.
- Queued tasks keep a resting pose and show the task at the desk. Real source-tool events drive reading/mouse motion; real text deltas drive typing bursts with pauses. Unknown working activity uses an attentive pose without invented typing. Dependencies stop work and identify the predecessor. Input questions turn toward the viewer. Newly applied updates briefly acknowledge once; queued commands and historical applied commands never do. Stopped tasks show their last reported state; completed outputs become available in the inspector. The illustrative inspector portraits are not identities of the animated characters.
- Monitor lights illuminate the actual face and hand surfaces only during reported work, independently of selection. Idle, completed, stopped and offline desks lose working light. Paused/reduced motion, hidden pages and offscreen scenes suspend animation; changed state receives a static redraw. WebGL/asset failure retains live 2D controls. The preview still needs visual approval, asset/performance optimization, and final cross-browser review before release.

## Commands

| Control | Runtime behavior |
| --- | --- |
| Send update | Queued for the exact run/task/attempt. Applied is acknowledged only when the provider consumes it at a safe turn boundary. |
| Retry | Appears for a failed specialist. Continues owner-saved progress using the device’s currently configured brain; never submits the task from scratch silently. |
| Interrupt & revise | Mac cancels only the selected task and schedules a fresh attempt with unique actor/task IDs. Waiting dependent reports use the new result. Phone stops its current run and starts one linked follow-up with a fresh run ID. |
| Stop agent (agent menu) | Cancels the exact selected task. Mac dependent reports are blocked rather than silently using an incomplete result. |
| Stop team (agent menu) | Stops the current Mac team, not another run or device. |
| Follow up | Supplies saved results as context; does not replay past external effects. Team membership is preserved. |

Commands carry a UUID, exact task identity and attempt. Identical retries return the original command; reusing an ID with different instructions is rejected. Phone commands are owner-scoped and retain their captured Phone/Mac target across navigation. Offline controls are disabled, retain the last known state and preserve drafts. Changing runs, attempts or devices does not send an existing draft automatically.

Mac Gemini, OpenAI and Ollama support safe live updates. Claude currently supports interruption/revision, not live updates; Send update is disabled honestly. Revisions are rejected if a downstream report has already consumed the selected task. Stop is not rollback: an already-started effect may finish, and changes already made remain. Existing task grants, private mode, time budgets, durable state, owner checks and model/tool limits remain authoritative. Each device still permits one active bot mission; the office does not introduce hidden parallel jobs.

## Failed-agent recovery — October 13

Retry is one primary glass button in the selected agent’s inspector: the native 36px Mac control or 44px Phone control. Finished and stopped agents do not show it; offline and busy controls are disabled. It needs no new instruction. Request IDs survive transport failures and a missing acknowledgment reconciles with the accepted attempt instead of starting another worker.

Mac starts a fresh provider attempt with the saved partial draft, completed tool journal, artifacts and applied updates. This is continuation from durable progress, **not** resuming an undocumented live provider session. Completed teammates are retained; never-started reports blocked by this dependency can proceed again. The canonical mission stays the same, with immutable coordinator attempts for terminal retries. Recovery after a restart and deletion of retry records are covered by regression tests. Previously successful matching writes return the saved outcome without executing the handler again; missing journal/outcome data fails closed.

Phone saves actual provider messages, tool-response groups, completed effects, applied updates and partial output in the owner’s bot state. A valid checkpoint resumes at the next unfinished step. Older runs without a full checkpoint use explicitly labeled saved-context continuation and block writes. Temporary server storage cannot survive a server restart; durable account storage is required for that guarantee.

Both paths refuse uncertain external effects, changed agent roles/grants and stale attempts. Retry does not roll back changes or bypass account access, privacy, confirmation, resource locks or tool grants. Time-budget exhaustion is a failure eligible for Retry; deliberate Stop remains stopped and needs a follow-up instead. Each attempt has a fresh bounded runtime budget; at most ten attempts are allowed before the user must review the failure and choose a follow-up. Phone retains 30 runs and 256 retry acknowledgments; expired records never silently create another attempt. Echo remains the coordinator, not a retryable office specialist. This change does not add automatic voice delivery.

Focused checks: Mac `agentretrytest` plus native `test:panel-office`; Phone `test/agent-control.test.mjs` plus `test:ui:retry` in Chromium and WebKit. Fixtures verify saved tool results, partial drafts, exact routing, dependency reactivation, repeated clicks, lost acknowledgments, offline controls, uncertain writes and late worker results. No live model calls or production tasks are used.

Pre-publication verification: Mac offline suite 120/120, build and native office controls; Phone offline suite 170/170, Retry and existing Bots controls in Chromium/WebKit. External HTTP was blocked during both offline suites. Retry previews contain isolated example tasks, not production activity.

## Earlier office verification

Mac: `npm run typecheck`, `npm run botstest`, `npm run agentcontroltest`, scheduler/mission/interjection regressions, `npm run test:panel-bots`, `npm run test:panel-office` and the application build. Dedicated controls tests cover exact-agent routing, acknowledgements, pending updates, retries, revision attempts, late-result fences and per-agent interruption. Desktop UI tests cover the restricted IPC bridge, provider capabilities, draft retention, responsive layouts, lighting, paused animation and offline controls.

The local finishing review checked the new office and inspector at Mac and Phone sizes, primary Phone actions above navigation at 390×844, individual-agent revise/stop and team stop, new-run selection, preserved drafts, single-frame state renders while motion is paused and all labels in 2D fallback. Screenshots use isolated automated fixture data, never production tasks. Asset provenance is recorded in `office-assets/README.md`.

Phone: `npm test` (146 tests), `npm run test:ui:bots` in Chromium and WebKit, and `npm run test:ui:office` in Chromium and WebKit. The office test runs a real isolated relay/model fixture through task → lit screen → queued update → consumed update → result, verifies zero working light after completion, target isolation, reduced motion and 320–1280px layouts. Browser scripts accept `ECHO_BROWSER_DEPENDENCIES` when Playwright is provided by a shared development runtime. No production user tasks or model spending are used by these fixtures.

## Direction contract

THESIS: A live office and inspector make agent work observable and individually steerable, while the runner remains the sole authority.

OWN-WORLD: Preserve Echo's existing cyan/charcoal layered liquid-glass language and original humanoid, not the reference application's visual theme.

STORY: Assign work, select a desk, inspect actual activity and reports, then update or interrupt that exact task. Close the inspector to return to the full office.

FIRST VIEWPORT: The office fills available panel space with every actual specialist visible without workspace scrolling. A desk opens an on-demand inspector: side pane on Mac, bottom sheet on Phone. Long reports scroll inside the inspector or history dialog, not the office. Phone update/revise remains above navigation at 390×844.

FORM: User-selected option A, Office + Inspector, from the three preview compositions; the existing visual world is fixed.

FINISH: Review the rendered Mac and Phone layouts and document the runtime/control wiring; retain licensed asset provenance and verify the release health.

## Local viewport polish — October 12

Both isolated UI suites verify the actual task/control adapters, 36/44px targets, exact task/attempt identity, retry IDs, hidden coordinator controls, six-seat fixtures, no workspace scrolling, preserved drafts, safe Markdown, history/follow-up/management, offline targets and reduced motion. Safari regressions cover deferred ResizeObserver writes and completed output remaining visible instead of shrinking to zero. The UI still shares one authoritative runner; this sizing pass does not add a new automatic voice-delivery mechanism. Echo voice completion reporting remains separate unfinished wiring work, rather than a claimed feature of the decorative coordinator tile. No push/deploy or 12UI reference upload occurred; production appearance and asset/performance gates remain pending.
