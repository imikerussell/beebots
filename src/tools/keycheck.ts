// Read-only key check. No orders, no transfers, no Jev decisions.
// Prints only sanitised facts: works?, permissions, IP-bound yes/no, sub-account yes/no, distinct accounts, USDC equity.
// Never prints key values, UIDs, labels or IPs.
// pnpm keycheck
// KEYCHECK_ONLY=live|demo checks just that set (deploy.sh preflight). KEYCHECK_MIN_USDC=333 also fails any bee
// whose USDC equity is below that (live go-live check: each bee must start with its full stake).
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { BEES, type OkxCreds } from "../config.js";
import { createOkxCli } from "../okx/cli.js";
import { safeError } from "../redact.js";

const env = process.env;
const only = env.KEYCHECK_ONLY === "live" || env.KEYCHECK_ONLY === "demo" ? env.KEYCHECK_ONLY : "";
const minUsdc = Number(env.KEYCHECK_MIN_USDC || 0);
const cli = createOkxCli({ site: "eea", timeoutMs: 10_000, maxConcurrent: 2 });
type Row = Record<string, string>;
let failures = 0;

// ---- Jev: list models (free, no decision call) ----
try {
  const require = createRequire(import.meta.url);
  const { TypeSafeClient } = require("@typesafe-ai/sdk");
  const c = new TypeSafeClient({ logLevel: "off", retry: { maxRetries: 0 }, timeout: 8000 });
  const models = (await c.models.list()) as Array<{ name: string }>;
  const pinned = env.JEV_MODEL || "jev-1.13.0";
  const has = models.some((m) => m.name === pinned);
  // The list shows aliases (jev-latest, jev-preview), not pinned versions; decision responses report the resolved version.
  console.log(`Jev          key OK · models listed: ${models.map((m) => m.name).join(", ")}${has ? "" : ` · pin ${pinned} is not listed (aliases only); confirm via model= in a decision response`}`);
} catch (err) {
  failures++;
  const e = safeError(err);
  console.log(`Jev          FAILED ${e.code} ${e.message}`);
}

// ---- OKX, per bee, live and demo keys ----
const uids = new Map<string, string>(); // internal only, never printed
// VPS IP, resolved locally and compared only; never printed.
let vpsIp = "";
try {
  const h = env.VPS_HOST ?? "";
  vpsIp = /^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : h ? (await lookup(h, { family: 4 })).address : "";
} catch {
  /* unresolved */
}
for (const kind of ["live", "demo"] as const) {
  if (only && kind !== only) continue;
  for (const bee of BEES) {
    const p = bee.toUpperCase();
    const infix = kind === "demo" ? "OKX_DEMO_API" : "OKX_API";
    const k = env[`${p}_${infix}_KEY`];
    const s = env[`${p}_${infix}_SECRET`];
    const ph = env[`${p}_${infix}_PASSPHRASE`];
    const tag = `${bee.padEnd(6)} ${kind.padEnd(4)}`;
    if (!k && !s && !ph) {
      if (only) failures++;
      console.log(`${tag}  not set`);
      continue;
    }
    if (!k || !s || !ph) {
      failures++;
      console.log(`${tag}  INCOMPLETE (key, secret and passphrase must all be set)`);
      continue;
    }
    const creds: OkxCreds = { apiKey: k, secretKey: s, passphrase: ph };
    const run = <T>(args: string[]) => cli.run<T>({ args, bee, creds, demo: kind === "demo" });
    try {
      const [cfg] = await run<Row[]>(["account", "config"]);
      if (!cfg) throw new Error("empty account config");
      const perms = (cfg.perm ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const withdraw = perms.some((x) => /withdraw/i.test(x));
      const isSub = !!cfg.uid && !!cfg.mainUid && cfg.uid !== cfg.mainUid;
      const bound = (cfg.ip ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const ipBound = bound.length > 0;
      const vpsBound = vpsIp ? bound.includes(vpsIp) : null;
      if (cfg.uid) uids.set(`${kind}:${bee}`, cfg.uid);
      let usdc = "?";
      let usdcNum = Number.NaN;
      try {
        const [bal] = await run<Array<{ details?: Row[] }>>(["account", "balance", "USDC"]);
        const d = bal?.details?.find((x) => x.ccy === "USDC");
        usdcNum = d ? Number(d.eq || 0) : 0;
        usdc = `$${usdcNum.toFixed(2)}`;
      } catch (err) {
        usdc = `balance read failed (${safeError(err).code})`;
      }
      const problems = [
        withdraw && "HAS WITHDRAW PERMISSION (hard rule 1: revoke it)",
        !perms.includes("trade") && "no Trade permission (engine cannot place orders)",
        !isSub && "NOT a sub-account (looks like the master account)",
        kind === "live" && !ipBound && "not IP-bound (unbound Trade keys expire after 14 days idle; bind to the VPS)",
        kind === "live" && ipBound && vpsBound === false && "VPS IP is NOT in this key's IP list: add it in OKX before running on the VPS (error 50110 otherwise)",
        cfg.posMode && cfg.posMode !== "net_mode" && `posMode ${cfg.posMode} (engine will switch it to net_mode)`,
      ].filter(Boolean);
      const short = kind === "live" && minUsdc > 0 && !(usdcNum >= minUsdc);
      if (short) problems.push(`USDC equity ${usdc} is below the $${minUsdc} start (or unreadable)`);
      if (withdraw || !perms.includes("trade") || !isSub || (kind === "live" && vpsBound === false) || short) failures++;
      console.log(`${tag}  key OK · perms ${perms.join("+") || "?"} · IP-bound ${ipBound ? `yes (${bound.length})` : "no"}${kind === "live" && vpsBound !== null ? ` · VPS in list ${vpsBound ? "yes" : "NO"}` : ""} · sub-account ${isSub ? "yes" : "NO"} · USDC equity ${usdc}`);
      for (const pr of problems) console.log(`${" ".repeat(13)}  ⚠ ${pr}`);
    } catch (err) {
      const e = safeError(err);
      const hint =
        e.code === "50110" || /ip/i.test(e.message)
          ? "refused from this machine: key is IP-bound elsewhere (expected for live keys bound to the VPS; re-test from the VPS)"
          : e.code === "50119"
            ? "wrong host/site for this key (EEA keys only work on eea.okx.com)"
            : e.code === "50111" || e.code === "50113" || e.code === "50105"
              ? "key, secret or passphrase is wrong"
              : e.code === "50101"
                ? "demo/live mismatch: this key belongs to the other environment"
                : "";
      failures++;
      console.log(`${tag}  FAILED ${e.code} ${e.message}${hint ? `\n${" ".repeat(15)}→ ${hint}` : ""}`);
    }
  }
}

for (const kind of ["live", "demo"]) {
  if (only && kind !== only) continue;
  const ids = BEES.map((b) => uids.get(`${kind}:${b}`)).filter((x): x is string => !!x);
  if (ids.length >= 2) {
    const distinct = new Set(ids).size === ids.length;
    if (!distinct) failures++;
    console.log(`${kind} keys map to ${distinct ? "distinct accounts: yes" : "the SAME account: NO, each bee needs its own sub-account"}`);
  }
}
console.log(failures ? `\n${failures} problem(s) found` : "\nall checks passed");
process.exit(failures ? 1 : 0);
