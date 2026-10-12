# Agent brain routing — local verification

2026-10-13; not pushed or deployed.

Standalone Phone agents already share normal Phone Echo chat's configured Gemini client and model through createCloud.chat. A regression test now checks normal chat plus all six specialists under two fixture model configurations and ensures role-provided model fields cannot replace that selection. All 148 Phone tests pass; no live model requests were made for these checks.

When the execution target is Mac, existing requests still go to Mac's bot service. The corresponding Mac change makes all specialist/custom/Lead launches follow Mac Echo's active provider and model, removes forced Claude/Ollama tier routing, snapshots configuration for running work and refuses silent provider fallback. Phone mode retains its own configured brain and does not require Mac online. No new Phone provider selector or cross-device credential transfer is introduced.
