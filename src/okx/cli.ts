// Thin wrapper around OKX's own Agent Trade Kit CLI (@okx_ai/okx-trade-cli, MIT).
// Every OKX call the engine makes, public or private, goes through `okx ... --json`,
// except public funding-rate, which the CLI rejects for X-Perp ids (see okx/public.ts).
//
// Secrets: the three profiles (bee1 / bee2 / bee3) in ~/.okx/config.toml carry only
// `site = "eea"`. The keys stay in .env and are injected per call into the child's env
// (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE take precedence over the profile in the kit).
// The child gets a minimal env, so one bee's call never sees another bee's keys.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { BeeId, OkxCreds } from "../config.js";
import { redactString } from "../redact.js";

const require = createRequire(import.meta.url);
const CLI_JS = require.resolve("@okx_ai/okx-trade-cli/dist/index.js");

export class OkxCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OkxCliError";
  }
}

export interface CliCall {
  args: string[];
  /** Which bee's profile + keys to use. Omit for public (keyless) calls. */
  bee?: BeeId;
  creds?: OkxCreds;
  /** true = --demo (x-simulated-trading), false = --live. Demo has its own instrument ids, so public calls pass it too. */
  demo?: boolean;
}

export interface OkxCli {
  run<T = unknown>(call: CliCall): Promise<T>;
}

/** Pull an OKX error code like 51008 out of the CLI's stderr, if there is one. */
function parseCliError(stderr: string, stdout: string): OkxCliError {
  const text = `${stderr}\n${stdout}`;
  const code = /\b(5\d{4}|50\d{3})\b/.exec(text)?.[1] ?? "CLI";
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("Error:")) ?? text.trim().split("\n")[0] ?? "okx cli failed";
  return new OkxCliError(code, redactString(line.replace(/^Error:\s*/, "")).slice(0, 240));
}

export function createOkxCli(opts: { site: "eea"; timeoutMs: number; maxConcurrent?: number }): OkxCli {
  let active = 0;
  const queue: Array<() => void> = [];
  const maxConcurrent = opts.maxConcurrent ?? 6;
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrent) {
        active++;
        resolve();
      } else queue.push(() => (active++, resolve()));
    });
  const release = () => {
    active--;
    queue.shift()?.();
  };

  return {
    async run<T>(call: CliCall): Promise<T> {
      const flags = ["--site", opts.site, "--json"];
      if (call.bee) flags.push("--profile", call.bee);
      if (call.demo !== undefined) flags.push(call.demo ? "--demo" : "--live");
      else if (call.creds) flags.push("--demo"); // keyed call with no explicit mode: never default to live
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OKX_UPDATE_CHECK: "false",
        OKX_TIMEOUT_MS: String(opts.timeoutMs),
        OKX_LOG_RETENTION_DAYS: "7",
      };
      if (call.creds) {
        env.OKX_API_KEY = call.creds.apiKey;
        env.OKX_SECRET_KEY = call.creds.secretKey;
        env.OKX_PASSPHRASE = call.creds.passphrase;
      }
      await acquire();
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            [CLI_JS, ...flags, ...call.args],
            { env, timeout: opts.timeoutMs + 2000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
            (err, out, errOut) => (err ? reject(parseCliError(errOut ?? "", out ?? "")) : resolve(out)),
          );
        });
        try {
          return JSON.parse(stdout) as T;
        } catch {
          throw new OkxCliError("PARSE", `non-JSON output from okx ${call.args.slice(0, 2).join(" ")}`);
        }
      } finally {
        release();
      }
    },
  };
}
