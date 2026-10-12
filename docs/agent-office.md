# Echo agent workspace

The Bots page and the Agents → Agent office link open one workspace backed by the existing bot runner. This is a native Echo visualization inspired by [Hermes3D](https://github.com/iamlukethedev/Hermes3D), not a second Hermes server, independent scheduler, or simulated execution feed. The bundled Three.js 0.170.0 renderer retains its MIT license in `renderer/vendor/three-LICENSE.txt` (Phone: `public/vendor`). No remote scripts or character downloads are required.

## Interface and authority

- The approved Office + Inspector composition inherits Echo's layered liquid-glass palette, rims, controls and typography. Narrow layouts put the horizontally scrollable roster before the scene.
- Echo uses the existing detailed particle humanoid. On Mac team tasks, the existing `lead` task is displayed as Echo: it waits for specialist reports, then combines them. Standalone Phone runs have no invented lead worker; Echo's tile is the workspace overview, and users select the actual assigned bot to control it.
- Desk labels and the roster select the same agent. Selection focuses that desk; Reset view returns to the whole office. Assignment uses the existing task form. Manage agents opens the existing roster editor. Results and prepared actions remain in the existing Runs & results history.
- The 3D characters are locally modeled, proportionate, articulated people with facial details, finger typing, head movement, breathing and furnished desks. They are stylized, not photorealistic humans. Motion communicates actual working/idle state, not fictional progress percentages or model thoughts. Tool activity is separately reported from actual runner events.
- Working monitors emit cyan light into the face and hands. Idle, completed, stopped and offline desks lose that working light. Paused motion, reduced motion, hidden pages and offscreen scenes suspend animation; a connected 2D view remains usable without WebGL.

## Commands

| Control | Runtime behavior |
| --- | --- |
| Send update | Queued for the exact run/task/attempt. Applied is acknowledged only when the provider consumes it at a safe turn boundary. |
| Interrupt & revise | Mac cancels only the selected task and schedules a fresh attempt with unique actor/task IDs. Waiting dependent reports use the new result. Phone stops its current run and starts one linked follow-up with a fresh run ID. |
| Stop agent | Cancels the exact selected task. Mac dependent reports are blocked rather than silently using an incomplete result. |
| Stop team | Stops the current Mac team, not another run or device. |
| Follow up | Supplies saved results as context; does not replay past external effects. Team membership is preserved. |

Commands carry a UUID, exact task identity and attempt. Identical retries return the original command; reusing an ID with different instructions is rejected. Phone commands are owner-scoped and retain their captured Phone/Mac target across navigation. Offline controls are disabled, retain the last known state and preserve drafts. Changing runs, attempts or devices does not send an existing draft automatically.

Mac Gemini, OpenAI and Ollama support safe live updates. Claude currently supports interruption/revision, not live updates; Send update is disabled honestly. Revisions are rejected if a downstream report has already consumed the selected task. Stop is not rollback: an already-started effect may finish, and changes already made remain. Existing task grants, private mode, time budgets, durable state, owner checks and model/tool limits remain authoritative. Each device still permits one active bot mission; the office does not introduce hidden parallel jobs.

## Verification

Mac: `npm run typecheck`, `npm run botstest`, `npm run agentcontroltest`, scheduler/mission/interjection regressions, `npm run test:panel-bots`, `npm run test:panel-office` and the application build. Dedicated controls tests cover exact-agent routing, acknowledgements, pending updates, retries, revision attempts, late-result fences and per-agent interruption. Desktop UI tests cover the restricted IPC bridge, provider capabilities, draft retention, responsive layouts, lighting, paused animation and offline controls.

The finishing review resolved the narrow Mac layout, visible face framing, dirty state renders while motion is paused, and restoring all labels in 2D fallback. A narrow detector exception retains the user-confirmed existing glass glow. New office controls and text were checked on the rendered dark surfaces; legacy small labels elsewhere in the shell were left unchanged. Documentation screenshots embed their automated-fixture provenance and contain no production task data.

Phone: `npm test` (145 tests), `npm run test:ui:bots` in Chromium and WebKit, and `npm run test:ui:office` in Chromium. The office test runs a real isolated relay/model fixture through task → lit screen → queued update → consumed update → result, verifies zero working light after completion, target isolation, reduced motion and 320–1280px layouts. Browser scripts accept `ECHO_BROWSER_DEPENDENCIES` when Playwright is provided by a shared development runtime. No production user tasks or model spending are used by these fixtures.

## Direction contract

THESIS: A live office and inspector make agent work observable and individually steerable, while the runner remains the sole authority.

OWN-WORLD: Preserve Echo's existing cyan/charcoal layered liquid-glass language and original humanoid, not the reference application's visual theme.

STORY: Assign work, select a desk or roster agent, inspect its actual activity and reports, then update or interrupt that exact task.

FIRST VIEWPORT: Mac office beside inspector; phone roster, office, then inspector. Assignment remains immediately available above the office.

FORM: User-selected option A, Office + Inspector, from the three preview compositions; the existing visual world is fixed.

FINISH: Review the rendered Mac and Phone layouts and document the runtime/control wiring; retain licensed asset provenance and verify the release health.
