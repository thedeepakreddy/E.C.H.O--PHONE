// Adapted from CopilotKit/OpenBot (MIT); see LICENSE and UPSTREAM.md.
function userContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    const item = part ?? {};
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    const source = item.source;
    if (item.type === "image" && source?.type === "data" && typeof source.value === "string" && source.value.trim() && /^[A-Za-z0-9+/]*={0,2}$/.test(source.value.replace(/\s/g, "")) && typeof source.mimeType === "string" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      source.mimeType.trim().toLowerCase()
    )) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${source.mimeType.trim().toLowerCase()};base64,${source.value}`
        }
      };
    }
    const name = typeof item.type === "string" && item.type ? item.type : "unknown";
    return { type: "text", text: `[${name}]` };
  });
}
export {
  userContent
};
