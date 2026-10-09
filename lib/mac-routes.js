/** Optional Mac routes: shared by relay dispatch and private diagnostics. */
export const MAC_ROUTES = new Set([
  "/login", "/status", "/events", "/pending", "/confirm", "/command", "/voice", "/mouse", "/keys",
  "/action", "/stop", "/frame", "/signout-all", "/close", "/log", "/rtc/offer", "/rtc/answer", "/rtc/ice",
  "/chat", "/chat/voice", "/chat/import", "/passkey/options", "/passkey/register", "/passkey/login",
]);
