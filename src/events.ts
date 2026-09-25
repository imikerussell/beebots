import type { Db } from "./db.js";
import { redact } from "./redact.js";

export type EventType = "decision" | "order" | "fill" | "funding" | "equity" | "cap" | "recon" | "heartbeat" | "status";

export interface BeeEvent {
  type: EventType;
  ts: number;
  [k: string]: unknown;
}

type Listener = (line: string, ev: BeeEvent) => void;

/** Every SSE event goes through redact() and is persisted (except high-rate equity/heartbeat). */
export class EventBus {
  private listeners = new Set<Listener>();

  constructor(private db: Db | null) {}

  emit(type: EventType, data: Record<string, unknown>, ts = Date.now()): BeeEvent {
    const ev = redact({ type, ts, ...data }) as BeeEvent;
    const line = JSON.stringify(ev);
    if (this.db && type !== "equity" && type !== "heartbeat") this.db.insertEvent(ts, type, line);
    for (const l of this.listeners) l(line, ev);
    return ev;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}
