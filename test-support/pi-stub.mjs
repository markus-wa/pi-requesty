/**
 * Test seam for the peer dependency.
 *
 * Extensions import `@earendil-works/pi-coding-agent` and pi provides it at
 * runtime, so the package is not installed in this repo and `npm test` could not
 * resolve it. This module registers a resolver hook that answers that one
 * specifier with itself, and exports the two functions the extension uses:
 *
 * - `getAgentDir()`  — mirrors pi's, including `PI_CODING_AGENT_DIR`
 * - `readStoredCredential()` — mirrors pi's reader: one synchronous read of
 *   `auth.json`, BOM-stripped, `undefined` on a missing or unreadable file, and
 *   no resolution of configured `!command`/`$VAR` values
 *
 * It lives outside `test/` because the test runner treats every file in that
 * directory as a test file.
 *
 * Consequence worth knowing: the suite exercises the extension's handling of a
 * credential, not pi's own parsing of the file, which pi's tests cover. The real
 * reader is exercised end to end by running the extension under pi.
 */
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";

export function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent");
}

export function readStoredCredential(providerId, authPath = path.join(getAgentDir(), "auth.json")) {
  try {
    const raw = fs.readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return data[providerId];
  } catch {
    return undefined;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
