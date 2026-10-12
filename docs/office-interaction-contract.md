# Office camera — local review contract

2026-10-13. Scope: interactive presentation in both Echo Mac and Phone. No execution API, new character asset, paid conversion, Git push or deployment.

## Inputs and ownership

- Click/tap a visible specialist character, chair, desk or monitor: raycast the nearest visible scene mesh, resolve its desk's stable specialist ID, select the existing inspector, and focus that desk. Room surfaces and props can occlude a pick. Echo is not a specialist and cannot be picked as one.
- Existing desk labels remain keyboard-accessible selection controls. Canvas instructions describe arrow keys, plus/minus, Enter to inspect, and Home for the full office. Escape uses the existing inspector/menu dismissal logic.
- One-pointer drag rotates. A release within six CSS pixels counts as a tap; dragging, multiple pointers, cancellation or lost capture cannot select an agent.
- Two-pointer pinch or wheel adjusts distance. Plus/minus buttons use the same camera state. Full-office resets camera and closes the inspector without losing its agent draft.
- Camera state never creates a task or agent command. Instruction routing retains target, run, specialist and attempt IDs. Busy command submission blocks specialist switching/inspector dismissal. Camera-only zoom/orbit remains available.
- Background polling preserves idle specialist selection. Resize updates framing without resetting orbit/zoom. Switching execution target clears focus. A removed focused specialist falls back to overview.
- Hidden/2D views disable gesture input; disposal releases capture/listeners. Offline viewing works on last-known scene data, while commands remain disabled. Reduced/paused motion snaps user-requested camera changes and does not manufacture task animation.

## Camera/readiness

39-degree vertical field of view. Overview fits the actual roster in three desktop or two narrow-stage columns. Focus starts at yaw -0.65 radians and pitch 0.2, using the desk's current responsive position. Orbit is intentionally bounded to a front-side hemisphere: yaw [-1.05, 1.05], pitch [0.1, 0.85]. Zoom scale: overview [0.55, 1.75], focused [0.65, 2.5]; absolute distance [1.5, 25] metres. This is an orbit viewer, not unrestricted navigation/walking or a collision-certified camera. The ceiling uses an overhead cutaway when the camera rises above 3.5 metres.

Scene loading precedes enabling camera buttons. Rendering diagnostics expose camera mode/focus/radius and projected head locations for coordinate-level tests; tests check that the canvas, not a label, receives the click. Phone's shell cache and application-version hash include the navigation module.

Zoom scale also respects the absolute near/far distance limits, so reversing direction at a limit responds immediately without a dead zone. Focus labels sit in the top-right corner rather than covering the selected specialist's head.

## Verified locally

Camera unit tests passed (focus and removed-agent reset, aspect preservation, finite inputs, bounds, immediate zoom reversal, tap/drag/pinch separation, cancellation, keyboard and listener disposal). Mac office tests passed using real character coordinates, 36px controls, keyboard orbit, full-office reset, no camera-generated commands, offline zoom and preserved instructions. Existing Mac agent-management/retry tests passed. Renderer-dependent camera assertions now wait on state rather than a fixed short delay; initial concurrent runs exposed timing failures in the older tests.

Phone office tests passed in Chromium and WebKit: real coordinate touch selection, mouse orbit, keyboard reset, zoom, preserved drafts, 2D input hiding, target isolation, responsive widths and existing queued/applied commands. Chromium tests used native two-finger touch events; WebKit used synthetic pointer integration plus the shared input unit tests, not a physical iPhone pinch. Existing Phone management/navigation tests passed in both engines. All 146 backend tests and Mac typecheck passed. No physical-device performance certification is implied.

## Review limits

Reuse incumbent layered glass and the previously acquired 12UI kit: Mac camera controls 36px; Phone 44px. No new conversion or pixel-alignment claim. This input contract does not replace the older single-view camera in room-brief.json or certify its pending Function/Form/Runtime gates. Those gates and physical-device performance remain pending. Existing stylized character quality, scene triangle budget, production Mac specialist roster and automatic Echo completion voice reporting are separate unfinished concerns. Local fixtures do not add production specialists.
