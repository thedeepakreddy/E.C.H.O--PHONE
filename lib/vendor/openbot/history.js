// Adapted from CopilotKit/OpenBot (MIT); see LICENSE and UPSTREAM.md.
import { NO_ANSWER_CAME } from "./bot-prompt.js";
import { userContent } from "./user-content.js";
function toProviderMessages(input) {
  const messages = [
    { role: "system", content: input.guidance },
    // AG-UI application context is separate from history. The A2UI catalog and tool instructions
    // arrive here; omitting them leaves the model guessing component names and action schemas.
    ...(input.context ?? []).map(({ description, value }) => ({
      role: "system",
      content: `${description}
${value}`
    }))
  ];
  const answered = new Set(
    input.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId).filter((id) => Boolean(id))
  );
  const resultsByCall = /* @__PURE__ */ new Map();
  for (const message of input.messages) {
    if (message.role !== "tool") continue;
    const id = message.toolCallId;
    if (id) resultsByCall.set(id, String(message.content ?? ""));
  }
  for (const message of input.messages) {
    if (message.role === "tool") continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: callDetails(call)
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...toolCalls?.length ? { tool_calls: toolCalls } : {}
      });
      for (const call of message.toolCalls ?? []) {
        if (!call.id) continue;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: answered.has(call.id) ? resultsByCall.get(call.id) ?? "" : NO_ANSWER_CAME
        });
      }
    }
  }
  return messages;
}
function callDetails(call) {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    // Still defaulted, because a call with no name at all is rejected outright by the provider and
    // showing the model something is better than losing the turn. It is now the last resort it was
    // meant to be rather than the ordinary path.
    name: typeof name === "string" && name ? name : "tool",
    arguments: typeof args === "string" ? args : args === void 0 || args === null ? "{}" : JSON.stringify(args)
  };
}
export {
  NO_ANSWER_CAME,
  toProviderMessages
};
