# Echo agent workspace

The Bots page and the Agents → Agent office link open one workspace backed by the existing bot runner. This is a native Echo visualization inspired by the office concept in Hermes3D, not a second Hermes server, independent scheduler, or simulated execution feed. The revised visual is photographic artwork extracted locally from the user's approved Office + Inspector reference, with live labels and lighting. It is explicitly not skeletal 3D or a live camera feed. No remote scripts, paid design conversion, external image upload or character downloads are required.

## Interface and authority

- The approved Office + Inspector composition inherits Echo's layered liquid-glass palette, rims, controls and typography. Mac places the office beside the inspector; Phone places the office above it. The compact roster follows the workspace. The toolbar selects the task and inspected agent; Assign task opens a focused native dialog rather than a permanent form below the office.
- Echo uses the existing detailed particle humanoid. On Mac team tasks, the existing `lead` task is displayed as Echo: it waits for specialist reports, then combines them. Standalone Phone runs have no invented lead worker; Echo's tile is the workspace overview, and users select the actual assigned bot to control it.
- Desk labels, the roster and agent selector select the same exact agent without moving or zooming the office. The initial inspector chooses the working specialist; polling respects a user's selection of Echo. Successful assignments and follow-ups select the accepted run. Workspace options contain Refresh, Manage agents, Office view, 2D view and Pause motion. Manage opens Mac's existing roster editor or Phone's custom-bot form. Results and prepared actions remain in the collapsed Runs & results history.
- The four pictured people are artwork, not fully animated photorealistic 3D characters. Working state adds subtle local hand-region motion and cyan monitor/face glow; it does not fabricate progress or model thoughts. The inspector lists actual runner activity and acknowledged command status. Unbound desks are marked unassigned. Extra/custom agents remain accessible through the roster and selector; portraits are illustrative role artwork, not verified identities.
- Idle, completed, stopped and offline desks lose working light. Paused motion, reduced motion, hidden pages and offscreen scenes suspend animation; changed state still receives a single static redraw. Unchanged polling does not restart paused animation. The 2D view remains usable if artwork cannot load. The UI does not advertise this illustrated office as a 3D view.

## Commands

| Control | Runtime behavior |
| --- | --- |
| Send update | Queued for the exact run/task/attempt. Applied is acknowledged only when the provider consumes it at a safe turn boundary. |
| Interrupt & revise | Mac cancels only the selected task and schedules a fresh attempt with unique actor/task IDs. Waiting dependent reports use the new result. Phone stops its current run and starts one linked follow-up with a fresh run ID. |
| Stop agent (agent menu) | Cancels the exact selected task. Mac dependent reports are blocked rather than silently using an incomplete result. |
| Stop team (agent menu) | Stops the current Mac team, not another run or device. |
| Follow up | Supplies saved results as context; does not replay past external effects. Team membership is preserved. |

Commands carry a UUID, exact task identity and attempt. Identical retries return the original command; reusing an ID with different instructions is rejected. Phone commands are owner-scoped and retain their captured Phone/Mac target across navigation. Offline controls are disabled, retain the last known state and preserve drafts. Changing runs, attempts or devices does not send an existing draft automatically.

Mac Gemini, OpenAI and Ollama support safe live updates. Claude currently supports interruption/revision, not live updates; Send update is disabled honestly. Revisions are rejected if a downstream report has already consumed the selected task. Stop is not rollback: an already-started effect may finish, and changes already made remain. Existing task grants, private mode, time budgets, durable state, owner checks and model/tool limits remain authoritative. Each device still permits one active bot mission; the office does not introduce hidden parallel jobs.

## Verification

Mac: `npm run typecheck`, `npm run botstest`, `npm run agentcontroltest`, scheduler/mission/interjection regressions, `npm run test:panel-bots`, `npm run test:panel-office` and the application build. Dedicated controls tests cover exact-agent routing, acknowledgements, pending updates, retries, revision attempts, late-result fences and per-agent interruption. Desktop UI tests cover the restricted IPC bridge, provider capabilities, draft retention, responsive layouts, lighting, paused animation and offline controls.

The local finishing review checked the new office and inspector at Mac and Phone sizes, primary Phone actions above navigation at 390×844, individual-agent revise/stop and team stop, new-run selection, preserved drafts, single-frame state renders while motion is paused and all labels in 2D fallback. Screenshots use isolated automated fixture data, never production tasks. Asset provenance is recorded in `office-assets/README.md`.

Phone: `npm test` (145 tests), `npm run test:ui:bots` in Chromium and WebKit, and `npm run test:ui:office` in Chromium. The office test runs a real isolated relay/model fixture through task → lit screen → queued update → consumed update → result, verifies zero working light after completion, target isolation, reduced motion and 320–1280px layouts. Browser scripts accept `ECHO_BROWSER_DEPENDENCIES` when Playwright is provided by a shared development runtime. No production user tasks or model spending are used by these fixtures.

## Direction contract

THESIS: A live office and inspector make agent work observable and individually steerable, while the runner remains the sole authority.

OWN-WORLD: Preserve Echo's existing cyan/charcoal layered liquid-glass language and original humanoid, not the reference application's visual theme.

STORY: Assign work, select a desk or roster agent, inspect its actual activity and reports, then update or interrupt that exact task.

FIRST VIEWPORT: Mac office beside inspector; Phone office then inspector. Assignment remains immediately available above the office, with update/revise above the bottom navigation at 390×844. Shorter screens scroll normally.

FORM: User-selected option A, Office + Inspector, from the three preview compositions; the existing visual world is fixed.

FINISH: Review the rendered Mac and Phone layouts and document the runtime/control wiring; retain licensed asset provenance and verify the release health.
