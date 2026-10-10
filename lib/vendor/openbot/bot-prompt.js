// Adapted from CopilotKit/OpenBot (MIT); see LICENSE and UPSTREAM.md.
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "",
  "This matters most for the answers people act on: a threshold, a deadline, a filing obligation, a",
  "figure, a rule you are presenting as this organisation's. Never state one of those as established",
  "here without having read it somewhere you can name. Saying 'I have not checked this against your",
  "own policy or the current regulation' costs you a sentence. Being confidently wrong about a",
  "number somebody acts on costs them a great deal more.",
  "",
  "This is not an instruction to go looking. If nothing you can reach covers the question, answer as",
  "well as you can and mark it plainly as unverified. Do not go hunting the open web for something",
  "to cite, and do not keep retrying a page that is not giving you one: an unsourced answer that",
  "says it is unsourced is honest, and a search that never ends is a Bot that never answers."
];
const PROVENANCE_GUIDANCE = PROVENANCE_GUIDANCE_LINES.reduce(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""]
).join("\n\n");
const NO_ANSWER_CAME = "No result. The person did not answer this, and the run it belonged to has ended. Do not wait for it and do not assume it succeeded. Carry on without it, and say plainly what you could not do if it mattered.";
export {
  NO_ANSWER_CAME,
  PROVENANCE_GUIDANCE
};
