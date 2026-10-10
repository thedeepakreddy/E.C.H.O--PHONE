# OpenBot source reuse

Source: https://github.com/CopilotKit/OpenBot
Pinned commit: a4dce8c47c7253ecd9bd6f4e2626f4205817a104
License: MIT (LICENSE retained).

history.ts and user-content.ts derive from agent-bot/src/history.ts and shared/user-content.ts. bot-prompt.ts retains shared provenance and unanswered-call guidance. Echo supplies accurate capability guidance rather than claiming OpenBot's separate computer service exists. agent-turn.ts adapts the actual streaming/tool-call buffering loop in agent-bot/src/index.ts into an injectable transport-free module. Echo owns execution, identity, limits and approval gates; no upstream UI is included. Phone carries mechanically compiled ES modules of the same source.
