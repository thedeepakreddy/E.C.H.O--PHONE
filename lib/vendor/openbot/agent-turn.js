// Adapted from CopilotKit/OpenBot (MIT); see LICENSE and UPSTREAM.md.
async function runAgentTurn(input, completion, emit, signal) {
  const check = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Run stopped");
  };
  const send = async (event) => {
    check();
    await emit(event);
  };
  await send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
  const messageId = `msg_${input.runId}`, toolCalls = /* @__PURE__ */ new Map();
  let textOpen = false, text = "";
  try {
    const stream = await completion();
    for await (const chunk of stream) {
      check();
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        if (!textOpen) {
          await send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          textOpen = true;
        }
        text += delta.content;
        if (text.length > 32e3) throw new Error("Bot response is too long");
        await send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: delta.content });
      }
      for (const call of delta.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0 || call.index > 15) throw new Error("Too many tool calls");
        const existing = toolCalls.get(call.index) ?? { id: call.id ?? `call_${input.runId}_${call.index}`, name: "", args: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        if (existing.args.length > 16e3) throw new Error("Tool arguments are too long");
        toolCalls.set(call.index, existing);
      }
    }
    if (textOpen) await send({ type: "TEXT_MESSAGE_END", messageId });
    // Assembly is not execution. The owner announces only calls it attempts.
    await send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
    return { text, calls: [...toolCalls.values()], messageId };
  } catch (error) {
    if (!signal?.aborted) await emit({ type: "RUN_ERROR", message: "The bot could not finish this turn." });
    throw error;
  }
}
/** Transport-free execution telemetry, called only after the owner's durable
 * checkpoint and authority check. Names/IDs describe this attempt, not a queue.
 */
async function runToolAttempt(input, execute, emit, signal) {
  const { args, denied, ...identity } = input;
  const check = () => { if (signal?.aborted) throw signal.reason ?? new Error("Run stopped"); };
  check();
  let started = false, ended = false;
  try {
    started = true;
    await emit({ ...identity, type: "TOOL_CALL_START" });
    check();
    await emit({ ...identity, type: "TOOL_CALL_ARGS", delta: args || "{}" });
    check();
    const result = await execute();
    const status = denied ? "denied" : ["failed", "denied", "uncertain", "cancelled", "waiting"].includes(result?.status) ? result.status : result?.error ? "failed" : "success";
    ended = true;
    await emit({ ...identity, type: "TOOL_CALL_END", status });
    return result;
  } catch (error) {
    // A stopped owner's observer may reject the end; never replay input or
    // replace the actual tool failure with a telemetry failure.
    if (started && !ended) {
      try { await emit({ ...identity, type: "TOOL_CALL_END", status: error?.toolStatus ?? (signal?.aborted ? "cancelled" : "failed") }); }
      catch { /* Preserve the tool failure even if the observer is unavailable. */ }
    }
    throw error;
  }
}
export {
  runAgentTurn,
  runToolAttempt
};
