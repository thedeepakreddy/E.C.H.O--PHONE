import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {networkInterfaces} from 'node:os';

const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
for (const interfaces of Object.values(networkInterfaces())) for (const entry of interfaces ?? []) {
  localHosts.add(entry.address);
  if (entry.family === 'IPv6') localHosts.add(`[${entry.address}]`);
}

/** Offline fixtures may bind this Mac's own addresses, but cannot call remote APIs. */
function assertLocal(target) {
  const host = target instanceof URL ? target.hostname : typeof target === 'string' ? new URL(target).hostname
    : target?.hostname ?? target?.host ?? 'localhost';
  if (!localHosts.has(String(host))) {
    throw new Error(`Offline test blocked remote network access to ${host}. Use a fixture or classify this test as live.`);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  assertLocal(input instanceof Request ? input.url : input);
  // Automatic redirects could turn a local fixture into a remote request.
  const redirect = options?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
  return originalFetch(input, {...options, redirect: redirect === 'manual' ? 'manual' : 'error'});
};
for (const transport of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (target, ...args) {
      assertLocal(target);
      if (args[0] && typeof args[0] === 'object' && (args[0].hostname || args[0].host)) assertLocal(args[0]);
      return original.call(this, target, ...args);
    };
  }
}
syncBuiltinESMExports();
