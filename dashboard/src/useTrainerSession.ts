import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "catfolio.trainer.session";
function readKey() {
  try { return sessionStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}
function remember(key: string) {
  try {
    if (key) sessionStorage.setItem(STORAGE_KEY, key);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Access still works in memory when browser storage is unavailable. */ }
}

/** Remember this tab, revalidate after refresh, and forget on explicit exit or revocation. */
export function useTrainerSession() {
  const [key, setKey] = useState("");
  const [restoring, setRestoring] = useState(() => !!readKey());
  const unlock = useCallback((value: string) => {
    remember(value); setKey(value); setRestoring(false);
  }, []);
  const lock = useCallback(() => {
    remember(""); setKey(""); setRestoring(false);
  }, []);
  useEffect(() => {
    if (key) return;
    const saved = readKey();
    if (!saved) { setRestoring(false); return; }
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function restore() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10_000);
      try {
        const response = await fetch("/coach/unlock", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${saved}` },
          body: "{}", signal: controller.signal,
        });
        if (!alive) return;
        if (response.status === 401) { lock(); return; }
        if (response.ok && (await response.json()).ok === true) {
          if (alive) unlock(saved);
          return;
        }
      } catch { /* A temporary outage must not erase a valid remembered session. */ }
      finally { clearTimeout(timeout); }
      if (alive) { setRestoring(false); retry = setTimeout(() => void restore(), 15_000); }
    }
    void restore();
    return () => { alive = false; clearTimeout(retry); controller?.abort(); };
  }, [key, lock, unlock]);
  return { trainerKey: key, restoring, unlockTrainer: unlock, lockTrainer: lock };
}
