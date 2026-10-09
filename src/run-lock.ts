import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
// PID alone is insufficient after a container restart or host reboot.
function processIdentity(pid: number): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${startTicks}`;
  }
  if (process.platform === "darwin")
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
  // Other platforms still fail closed on a live PID; stale dead PIDs are recovered.
  return "pid-only";
}
/** Prevent two engine processes from trading the same local ledger. Never share this file across hosts. */
export function lockRun(dbPath: string): () => void {
  const path = `${dbPath}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as
      | number
      | { pid: number; identity: string };
    const pid = typeof saved === "number" ? saved : saved.pid;
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(
        `Invalid run lock ${path}; inspect it before removing it`,
      );
    try {
      process.kill(pid, 0);
      if (typeof saved === "number" || saved.identity === processIdentity(pid))
        throw new Error(
          `Catfolio is already running (PID ${pid}) for this DB_PATH`,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    unlinkSync(path);
  }
  const value = JSON.stringify({
    pid: process.pid,
    identity: processIdentity(process.pid),
    nonce: randomUUID(),
  });
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, value);
  closeSync(fd);
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8") === value)
      unlinkSync(path);
  };
}
