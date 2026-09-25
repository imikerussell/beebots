import type { BeeId, OkxCreds } from "../config.js";
import { log } from "../log.js";
import type { Instrument, Ticker } from "../market/types.js";
import type { OkxCli } from "../okx/cli.js";
import { safeError } from "../redact.js";
import { formatSz } from "./sizing.js";

export interface OrderReq {
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  clOrdId: string;
}

export type OrderResult =
  | { ok: true; ordId: string | null; contracts: number; avgPx: number; feeUsd: number; ts: number }
  | { ok: false; error: { code: string; message: string }; state: "rejected" | "unknown" };

export interface ExchangePosition {
  instId: string;
  /** Signed contracts (net mode): + long, - short. */
  pos: number;
  avgPx: number;
}

export interface FundingBill {
  billId: string;
  instId: string | null;
  amountUsd: number;
  ts: number;
}

export interface Executor {
  readonly kind: "sim" | "okx";
  init(bee: BeeId): Promise<void>;
  market(bee: BeeId, req: OrderReq): Promise<OrderResult>;
  positions(bee: BeeId): Promise<ExchangePosition[] | null>;
  fundingBills(bee: BeeId): Promise<FundingBill[] | null>;
  /** Fees OKX charged for these order ids (USD, positive = paid). */
  feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null>;
}

/**
 * MODE=dry: real market data, simulated taker fills at the touch (mid +/- half spread), no OKX private calls.
 */
export class SimExecutor implements Executor {
  readonly kind = "sim" as const;
  constructor(
    private market_: () => { tickers: Map<string, Ticker>; instruments: Map<string, Instrument> },
    private takerFeeRate: number,
    private now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {}

  async market(_bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const { tickers, instruments } = this.market_();
    const t = tickers.get(req.instId);
    const inst = instruments.get(req.instId);
    if (!t || !inst) return { ok: false, error: { code: "SIM", message: "no ticker" }, state: "rejected" };
    const px = req.side === "buy" ? (t.ask > 0 ? t.ask : t.last) : t.bid > 0 ? t.bid : t.last;
    const feeUsd = req.contracts * inst.ctVal * px * this.takerFeeRate;
    return { ok: true, ordId: null, contracts: req.contracts, avgPx: px, feeUsd, ts: this.now() };
  }

  async positions(): Promise<null> {
    return null;
  }
  async fundingBills(): Promise<null> {
    return null;
  }
  async feesFor(): Promise<null> {
    return null;
  }
}

type Row = Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MODE=demo / live: market orders through the OKX Agent Trade Kit CLI, one profile per bee.
 * Isolated margin, net position mode, 2x leverage, reduceOnly on every close.
 */
export class OkxExecutor implements Executor {
  readonly kind = "okx" as const;
  private leverageSet = new Set<string>();

  constructor(
    private cli: OkxCli,
    private creds: Partial<Record<BeeId, OkxCreds>>,
    private demo: boolean,
    private instrument: (instId: string) => Instrument | undefined,
    private leverage: number,
  ) {}

  private run<T>(bee: BeeId, args: string[]): Promise<T> {
    const c = this.creds[bee];
    if (!c) throw new Error(`no OKX credentials for ${bee}`);
    return this.cli.run<T>({ args, bee, creds: c, demo: this.demo });
  }

  async init(bee: BeeId): Promise<void> {
    const [cfg] = await this.run<Row[]>(bee, ["account", "config"]);
    if (cfg?.posMode && cfg.posMode !== "net_mode") {
      log.info("setting net position mode", { bee });
      await this.run(bee, ["account", "set-position-mode", "--posMode", "net_mode"]);
    }
  }

  private async ensureLeverage(bee: BeeId, instId: string): Promise<void> {
    const key = `${bee}:${instId}`;
    if (this.leverageSet.has(key)) return;
    // /account/leverage-info 404s on EEA; set it and trust the positions read-back.
    await this.run(bee, ["futures", "leverage", "--instId", instId, "--lever", String(this.leverage), "--mgnMode", "isolated"]);
    this.leverageSet.add(key);
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const inst = this.instrument(req.instId);
    if (!inst) return { ok: false, error: { code: "INST", message: "unknown instrument" }, state: "rejected" };
    try {
      if (!req.reduceOnly) await this.ensureLeverage(bee, req.instId);
      const args = ["futures", "place", "--instId", req.instId, "--side", req.side, "--ordType", "market", "--sz", formatSz(req.contracts, inst), "--tdMode", "isolated", "--clOrdId", req.clOrdId];
      if (req.reduceOnly) args.push("--reduceOnly");
      const [ack] = await this.run<Row[]>(bee, args);
      if (!ack || (ack.sCode && ack.sCode !== "0")) {
        return { ok: false, error: { code: ack?.sCode ?? "NOACK", message: ack?.sMsg ?? "no ack" }, state: "rejected" };
      }
      // Market orders fill at once; poll for the fill details. The order is already placed, so a transient
      // read error here (seen: 50004 on OKX demo) must not end the poll: keep trying before reporting "unknown".
      for (let i = 0; i < 12; i++) {
        let o: Row | undefined;
        try {
          [o] = await this.run<Row[]>(bee, ["futures", "get", "--instId", req.instId, "--clOrdId", req.clOrdId]);
        } catch (err) {
          log.warn("fill poll failed, retrying", { bee, err: safeError(err) });
          await sleep(Math.min(4000, 400 * 2 ** Math.min(i, 3)));
          continue;
        }
        if (o && (o.state === "filled" || ((o.state === "canceled" || o.state === "mmp_canceled") && Number(o.accFillSz) > 0))) {
          return { ok: true, ordId: o.ordId ?? ack.ordId ?? null, contracts: Number(o.accFillSz), avgPx: Number(o.avgPx), feeUsd: -Number(o.fee || 0), ts: Number(o.uTime || o.cTime || Date.now()) };
        }
        if (o && o.state === "canceled") return { ok: false, error: { code: "CANCELED", message: "order canceled unfilled" }, state: "rejected" };
        await sleep(300);
      }
      return { ok: false, error: { code: "UNCONFIRMED", message: "fill not confirmed; reconciliation will settle it" }, state: "unknown" };
    } catch (err) {
      return { ok: false, error: safeError(err), state: "unknown" };
    }
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    try {
      const rows = await this.run<Row[]>(bee, ["futures", "positions"]);
      return rows.filter((r) => Number(r.pos) !== 0).map((r) => ({ instId: r.instId!, pos: Number(r.pos), avgPx: Number(r.avgPx) }));
    } catch (err) {
      log.warn("positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async fundingBills(bee: BeeId): Promise<FundingBill[] | null> {
    try {
      const rows = await this.run<Row[]>(bee, ["account", "bills", "--instType", "FUTURES", "--limit", "100"]);
      // type 8 = funding fee
      return rows.filter((r) => r.type === "8").map((r) => ({ billId: r.billId!, instId: r.instId || null, amountUsd: Number(r.balChg), ts: Number(r.ts) }));
    } catch (err) {
      log.warn("bills read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    try {
      const out = new Map<string, number>();
      for (const instId of instIds) {
        const rows = await this.run<Row[]>(bee, ["futures", "fills", "--instId", instId]);
        for (const r of rows) if (r.ordId && ordIds.has(r.ordId)) out.set(r.ordId, (out.get(r.ordId) ?? 0) - Number(r.fee || 0));
      }
      return out;
    } catch (err) {
      log.warn("fills read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}
