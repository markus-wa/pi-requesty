/**
 * Credential resolution for the Requesty extension.
 *
 * Model discovery calls `<baseUrl>/models` directly, outside pi's request
 * pipeline, so it needs the provider key itself — including a key that lives in a
 * secret manager:
 *
 *   { "requesty": { "type": "api_key", "key": "!secret-tool lookup requesty api-key" } }
 *
 * Values therefore follow pi's `resolveConfigValue` semantics (see
 * {@link resolveConfigValue}) and a resolved key is only ever held in memory: it
 * is never written back to `models.json`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_TIMEOUT_MS = 10_000;

/** Shell-command results, cached for the process lifetime. */
const commandResultCache = new Map();

/** Pi's agent directory, honoring `PI_CODING_AGENT_DIR`. */
export function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function authJsonPath() {
  return path.join(agentDir(), "auth.json");
}

export function modelsJsonPath() {
  return path.join(agentDir(), "models.json");
}

/** Whether a config value is a `!command` reference. */
export function isCommandConfigValue(config) {
  return typeof config === "string" && config.startsWith("!");
}

/** Clear cached shell-command results. Exported for tests. */
export function clearConfigValueCache() {
  commandResultCache.clear();
}

/**
 * Resolve an API key or header value to its actual value: a `!command` (trimmed
 * stdout, cached for the process, 10s timeout, `undefined` on failure), a value
 * with `$NAME`/`${NAME}` interpolated (`undefined` if a variable is unset, with
 * `$$`/`$!` escaping a literal `$`/`!`), or a literal.
 */
export function resolveConfigValue(config, env) {
  if (typeof config !== "string" || config.length === 0) {
    return undefined;
  }
  return isCommandConfigValue(config) ? executeCommand(config) : resolveTemplate(config, env);
}

/**
 * Read the stored `api_key` credential for a provider from `auth.json`.
 *
 * Read directly rather than through Pi's exported `readStoredCredential`: that is
 * the same plain read of the same file, with no value resolution, so importing it
 * would add a second path that a test here can never exercise.
 */
export function readStoredApiKey(providerId, options = {}) {
  const authPath = options.authPath ?? authJsonPath();
  const credential = readCredential(providerId, authPath);

  if (!credential) {
    return { reason: `no "${providerId}" credential in ${authPath}` };
  }
  if (credential.type !== "api_key") {
    return {
      reason: `the "${providerId}" credential in ${authPath} is of type "${credential.type}"; model discovery needs an "api_key" credential`,
    };
  }
  if (typeof credential.key !== "string" || credential.key.length === 0) {
    return { reason: `the "${providerId}" credential in ${authPath} has no key` };
  }

  const key = resolveConfigValue(credential.key, credential.env ?? options.env);
  if (key === undefined) {
    return {
      reason: `the "${providerId}" key in ${authPath} did not resolve (a failing command or an unset variable resolves to nothing)`,
    };
  }

  return { key, source: authPath };
}

/** `auth.json` holds one credential per provider id. */
function readCredential(providerId, authPath) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(authPath, "utf-8")));
    if (!data || typeof data !== "object") {
      return undefined;
    }
    const credential = data[providerId];
    return credential && typeof credential === "object" ? credential : undefined;
  } catch {
    return undefined;
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Execute a `!command` value, caching the result for the process lifetime. */
function executeCommand(config) {
  if (commandResultCache.has(config)) {
    return commandResultCache.get(config);
  }
  const result = executeCommandUncached(config);
  commandResultCache.set(config, result);
  return result;
}

function executeCommandUncached(config) {
  try {
    const output = execSync(config.slice(1), {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveTemplate(config, env) {
  let resolved = "";
  for (const part of parseTemplate(config)) {
    if (part.literal !== undefined) {
      resolved += part.literal;
      continue;
    }
    const value = env?.[part.name] || process.env[part.name];
    if (value === undefined) {
      return undefined;
    }
    resolved += value;
  }
  return resolved;
}

/**
 * Split a value into literal and `$NAME`/`${NAME}` parts, applying the `$$` and
 * `$!` escapes. A lone or malformed `$` stays literal.
 */
function parseTemplate(config) {
  const parts = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      parts.push({ literal: config.slice(index) });
      break;
    }
    if (dollarIndex > index) {
      parts.push({ literal: config.slice(index, dollarIndex) });
    }

    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      parts.push({ literal: nextChar });
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        parts.push({ literal: "$" });
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ name });
      } else {
        parts.push({ literal: config.slice(dollarIndex, endIndex + 1) });
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    parts.push({ literal: "$" });
    index = dollarIndex + 1;
  }

  return parts;
}
