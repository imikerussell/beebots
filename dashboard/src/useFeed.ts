import { useCallback, useEffect, useState } from "react";
import type { CatId, Decision, Profile, Snapshot } from "./types";
import { DECISION_LIMIT, decisionKey, isDecision, mergeDecisions } from "./decisionFeed";
export type Curve = Array<[number, number]>;
const CHART_REFRESH_MS = 60_000;
export function useFeed() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [curves, setCurves] = useState<Partial<Record<CatId, Curve>>>({});
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [liveDecisionKeys, setLiveDecisionKeys] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [historyStatus, setHistoryStatus] = useState<"loading" | "loaded" | "unavailable">("loading");
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
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let chartTimer: ReturnType<typeof setTimeout> | undefined;
    const get = async <T>(path: string): Promise<T> => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(path);
      return r.json() as Promise<T>;
    };
    const charts = async () => {
      try {
        const curves = await get<Partial<Record<CatId, Curve>>>("/equity?days=30");
        if (alive) setCurves(curves);
      } catch { /* Keep the last chart while the engine is unavailable. */ }
      finally {
        // Wait after completion so slow queries cannot accumulate in this tab.
        if (alive) chartTimer = setTimeout(() => void charts(), CHART_REFRESH_MS);
      }
    };
    const history = () => void get<unknown[]>(`/history?type=decision&n=${DECISION_LIMIT}`)
      .then((rows) => {
        if (!alive) return;
        setDecisions((prev) => mergeDecisions(prev, rows.filter(isDecision)));
        setHistoryStatus("loaded");
      }).catch(() => { if (alive) setHistoryStatus("unavailable"); });
    history();
    void refresh();
    void charts();
    let events: EventSource;
    let lastStreamSignal = Date.now();
    const connectStream = () => {
      lastStreamSignal = Date.now();
      events = new EventSource("/events");
      events.onopen = () => {
        if (!alive) return;
        lastStreamSignal = Date.now();
        setStreamStatus("live");
        history();
        // A second merge after the server's 2s cache expires covers decisions
        // recorded just before this connection opened, while SSE covers new ones.
        clearTimeout(recoveryTimer);
        recoveryTimer = setTimeout(history, 2500);
      };
      events.onerror = () => { if (alive) setStreamStatus("reconnecting"); };
      events.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (!alive) return;
          lastStreamSignal = Date.now();
          setStreamStatus("live");
          if (isDecision(d)) {
            setDecisions((prev) => mergeDecisions(prev, [d]));
            setLiveDecisionKeys((prev) => [...prev.filter((key) => key !== decisionKey(d)), decisionKey(d)].slice(-DECISION_LIMIT));
          }
        } catch {
          /* malformed event */
        }
      };
    };
    connectStream();
    const timer = setInterval(() => {
      if (Date.now() - lastStreamSignal > 45_000) {
        setStreamStatus("reconnecting");
        events.close();
        connectStream();
      }
      void refresh();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(chartTimer);
      clearTimeout(recoveryTimer);
      events.close();
    };
  }, [refresh]);
  return { snap, profile, curves, decisions, liveDecisionKeys, connected, streamStatus, historyStatus, refresh };
}
