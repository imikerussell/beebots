import { useCallback, useEffect, useState } from "react";
import type { CatId, Decision, Profile, Snapshot } from "./types";
export type Curve = Array<[number, number]>;
export function useFeed() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [curves, setCurves] = useState<Partial<Record<CatId, Curve>>>({});
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [sr, pr] = await Promise.all([fetch("/snapshot"), fetch("/profile")]);
      if (!sr.ok || !pr.ok) throw new Error("Engine unavailable");
      const [s, p] = await Promise.all([sr.json() as Promise<Snapshot>, pr.json() as Promise<Profile>]);
      setSnap(s); setProfile(p); setConnected(true);
    } catch { setConnected(false); }
  }, []);
  useEffect(() => {
    let alive = true;
    const get = async <T>(path: string): Promise<T> => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(path);
      return r.json() as Promise<T>;
    };
    const charts = () =>
      void get<Partial<Record<CatId, Curve>>>("/equity?days=30")
        .then((c) => alive && setCurves(c))
        .catch(() => {});
    void get<Array<Decision & { type: string }>>("/history?n=200")
      .then(
        (e) =>
          alive &&
          setDecisions(
            e
              .filter((d) => d.type === "decision")
              .reverse()
              .slice(0, 40),
          ),
      )
      .catch(() => {});
    void refresh();
    charts();
    const events = new EventSource("/events");
    events.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (alive && d.type === "decision")
          setDecisions((prev) => [d, ...prev].slice(0, 40));
      } catch {
        /* malformed event */
      }
    };
    const timer = setInterval(() => {
      void refresh();
      charts();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      events.close();
    };
  }, [refresh]);
  return { snap, profile, curves, decisions, connected, refresh };
}
