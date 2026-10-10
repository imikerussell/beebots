# Catfolio 🐈

Two independent cats, one selectable decision provider, and deterministic risk controls. A fork of [Mike Russell's beebots](https://github.com/imikerussell/beebots), retaining its OKX public-data client, indicators, SQLite ledger, execution adapters, event stream, and equity chart. Paper trading is the default. LM Studio / Nimble is the default and requires no paid cloud AI. Jev is an optional, explicitly selected billed cloud backend. The dashboard includes locally served generated cat portraits. No leaderboard reporting, Zapier, or remote rule rewriting.

**Current hardware verification:** on 2026-10-09 this machine's **LM Studio 0.4.9+1** returned HTTP 200 with `Unexpected endpoint or method. (POST /v1/systemone)`. Installed llama.cpp Metal runtime: **2.13.0**; MLX runtime: **1.10.1**. No model was loaded; only Qwen and an embedding model were downloaded. **This installed combination cannot run this integration. Real Nimble inference has NOT passed.** Update the application **and** select a runtime supporting native decision models, download/load a compatible Nimble artifact, then pass `pnpm local:check`. Merely having a chat server on port 1234 is insufficient. The implementation is tested against a local mock server; there is no chat or cloud fallback.

## First overnight paper run

Requires Node **22.13+** (Node 22 LTS recommended), pnpm **10.34.5**, Git, internet access to public OKX market data, and either a compatible local LM Studio installation or the optional Jev setup below. Commands are run from this repository. No exchange account is needed.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --dir dashboard install --frozen-lockfile
cp .env.example .env
pnpm run setup
```

`pnpm run setup` writes `data/catfolio-settings.json` with exactly two editable names/rules and refuses to overwrite an existing file. Defaults also work without this file. Configure the local model as described below. Edit `.env`: at minimum set `LM_STUDIO_MODEL`, and record `LM_STUDIO_VERSION`, `LM_STUDIO_ENGINE`, and `LM_STUDIO_ARTIFACT`. Keep `DRY_RUN=true`, `MODE=paper`, and the $200 total for the first run. Never copy old exchange credentials into this experiment.

```sh
pnpm local:check                  # MUST pass choice AND score; read-only, no trading
pnpm snapshot                     # live public market data and the TWO current menus
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --dir dashboard build
pnpm start                        # engine, http://127.0.0.1:8080
```

In another terminal:

```sh
pnpm --dir dashboard dev          # open http://127.0.0.1:5173
```

The first scheduled decision is after 60 seconds. Protective checks run every five seconds. The dashboard shows PAPER, each cat's allocated capital/equity, returns, positions/stops, costs, exposure, drawdown, recorded action/veto, and local inference requests/latency. “Local setup” explains the file-based setup; no keys are entered in the browser. “Morning report” opens the comparison and offers a JSON download.

The public **Decision stream** shows the latest 200 recorded decisions over `/events` (SSE), including WAIT/HOLD, rules-only decisions, blocked actions, protective exits, and model failures. Rows show action probabilities, response time, and total cat P&L at decision time when available; approval by risk checks is not confirmation of a fill. Filter by cat or pause the view to read without pausing trading. The connection indicator and last-decision age distinguish a quiet stream from a disconnected one. Recent decisions are merged from `/history?type=decision&n=200` on load and reconnect without duplicate rows; older events without the new fields still display. Streams send heartbeat events every 15 seconds; the dashboard reconnects if no event arrives for 45 seconds.

### Morning, stop, and resume

```sh
pnpm report                       # whole-run local report, latest recorded marks
pnpm report > morning-report.txt   # includes pnpm's command banner; for clean JSON use the command below
node --env-file-if-exists=.env dist/tools/report.js > morning-report.json
pnpm replay 1                     # inspect exact recorded decision 1, offline
pnpm replay 1 --infer             # repeat its typed request, never execute an order
pnpm paper:stop                   # ask running engine to flatten with fresh quotes
```

After `paper:stop`, keep the engine running until the dashboard says **Run closed. Both cats are flat.** The stop flag is `<DB_PATH>.stop`; the closed state is also durable in SQLite. Removing the flag alone never reopens a closed run. If quotes are unavailable, simulated exits wait for fresh data. You can inspect `http://127.0.0.1:8080/snapshot` and `/report` directly.

**Pause/resume the same run:** Ctrl+C (or SIGTERM) gracefully saves the ledger and cancels outstanding inference. It does **not** flatten positions. `pnpm start` resumes the same positions, stops, balances and daily counters, then checks protection before scheduling models. Stops cannot run while the process/computer is off. The report excludes unobserved downtime from exposure duration; funding during downtime is not reconstructed.

**Start a fresh experiment:** stop the old engine, retain its database and backups, then set e.g. `DB_PATH=./data/catfolio-night2-{mode}.sqlite` in `.env`. Start again. `TOTAL_START_EQUITY_USD` and allocation changes require a new database. Old three-bee databases/settings are refused when selected; they are never reinterpreted, funded again, or deleted. Default names (`catfolio-dry.sqlite`, `catfolio-settings.json`) differ from upstream's `bees-dry.sqlite` / `settings.json`. Do not run two engines against the same file; a process lock enforces this on one host. Do not put the active database on shared/network storage.

## Switch between LM Studio and Jev

Set **`DECISION_PROVIDER=lmstudio`** (default) or **`DECISION_PROVIDER=jev`** in `.env`, then restart the engine. Exactly one backend serves both cats. The same market snapshots, action menus, ordered rubric, validation, sizing and protective checks apply. An unavailable provider never switches to the other automatically. Choosing Jev sends the decision's market/account snapshot and strategy profile to TypeSafe's hosted API and can incur charges.

For Jev, keep `DRY_RUN=true` and `MODE=paper`, and set:

```dotenv
DECISION_PROVIDER=jev
TYPESAFE_API_KEY=your-key-here
JEV_MODEL=jev-1.13.0
DB_PATH=./data/catfolio-jev-night1-{mode}.sqlite
```

The default is the upstream pinned Jev model; use a supported **versioned** identifier, not a moving alias. The direct HTTP adapter follows the [official TypeSafe API](https://docs.typesafe.ai/api) and shares the same typed response validator with LM Studio. It does not use chat generation.

Jev returns probabilities and scores rounded separately to two decimals, as declared by the [official TypeSafe AI SDK adapter](https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-decision-model.ts). Its validator allows bounded rounding differences in probability totals, near-tied choices and weighted scores. It preserves the returned numbers: no probability normalization, conviction rounding-up or entry-threshold changes. Missing fields, out-of-range values, wrong model/rubric and larger inconsistencies still fail closed. Local LM Studio responses retain the stricter validation.

For a **Vercel AI Gateway key**, select the gateway explicitly instead:

```dotenv
DECISION_PROVIDER=jev
JEV_TRANSPORT=vercel
AI_GATEWAY_API_KEY=your-vercel-gateway-key
JEV_MODEL=typesafe-ai/jev
```

This uses Vercel's [TypeSafe-compatible endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe), preserving the same choice/score validation, timeouts and spending estimate. Gateway requests are billed through Vercel. The gateway model name is an alias rather than a pinned TypeSafe version; audits record the selected transport, endpoint and model. Direct access remains the default (`JEV_TRANSPORT=typesafe`) and requires a TypeSafe-issued key. Keys are never substituted between routes. Rebuild after code changes and recreate the engine after changing `.env`; run `pnpm provider:check` (or `docker compose exec engine node dist/tools/provider-check.js`) to verify the selected connection without placing an order.

```sh
pnpm provider:check   # Selected backend; Jev makes ONE potentially billed typed test, no order
pnpm build
pnpm start
```

To switch back, set `DECISION_PROVIDER=lmstudio`, configure `LM_STUDIO_MODEL`, and run `pnpm provider:check` again. The existing `pnpm local:check` always targets LM Studio. Docker uses the same `.env` switch; recreate the engine with `docker compose up -d --force-recreate engine`. Its paper-only trading safeguards remain enforced.

For comparison, use separate database paths/projects and keep starting capital and strategy settings identical. Close the earlier paper run with `pnpm paper:stop`, wait until flat, stop it, then select the next provider and fresh database. Changing provider while reusing a paused database preserves positions/cash; the report lists all backends used, but those mixed returns cannot be attributed cleanly to one provider. Different nights also have different markets; a few profitable trades do not establish which model is better.

For an input-matched comparison, point `DB_PATH` at the original run, select the other provider in `.env`, then run:

```sh
pnpm replay 1 --infer --compare-provider
```

This submits the recorded state, exact menu and rubric to the selected backend and prints its answer, without executing or changing trading positions. Hosted replay calls can be billed. Without `--compare-provider`, replay requires the original provider and model.

The dashboard labels **Local inference** or **Jev cloud**. Reports include backend/model identities, latency, failures and estimated cloud costs separately from trading P&L. `JEV_TIMEOUT_MS`, `JEV_CONCURRENCY`, `JEV_DAILY_USD_CAP` and `JEV_USD_PER_MTOK` are editable. The default price estimate ($0.042 per million input tokens) follows the [published model pricing](https://docs.typesafe.ai/models); check your current terms. The daily estimate survives restart in that database. It pauses further Jev requests when reached; protective checks and deterministic exits continue. This is a soft estimate, not an account-wide spending guarantee: an in-flight request can exceed the remaining budget, concurrent requests can overlap, and timeouts can still be billed without returning usage. Other databases and external API calls are not counted. These billing controls never apply to LM Studio. Per-cat API costs cover recorded engine decisions; connection checks and replays count toward the database's daily estimate but are not assigned to a cat's trading P&L.

Jev compatibility is covered by a credential-free mock HTTP server. No paid Jev inference was performed during this implementation; run `pnpm provider:check` with your key to verify it.

## Daily strategy coach

The dashboard includes an AI coach inspired by the original Beekeeper. The upstream implementation used a scheduled Zapier workflow, a scorecard, short-lived rewrite credentials, and strategy overlays. Catfolio now reviews each cat separately through Vercel and requires **Approve suggestion** before applying a change.

Use your existing `AI_GATEWAY_API_KEY` on the engine. The coach automatically enables when that key is present, independently of `DECISION_PROVIDER`. Set `COACH_ENABLED=false` to disable new reviews. Its separate text model defaults to `COACH_MODEL=anthropic/claude-sonnet-4.6`; Jev remains the trading decision model when selected. Requests use Vercel's [OpenAI-compatible chat API](https://vercel.com/docs/ai-gateway/openai-compat/rest-api). Coaching calls are billed through Vercel separately from the Jev spending estimate/cap, with at most two bounded requests per 24 hours for this database.

To enable dashboard approvals:

1. Generate a separate owner key with `openssl rand -hex 32` and put it in the engine's `.env` as `COACH_ADMIN_TOKEN` (minimum 24 characters).
2. Rebuild and restart the engine and dashboard. With Docker: `docker compose up -d --build`.
3. Click **you a trainer?** in the dashboard’s top-right corner and enter that owner key. A valid key unlocks suggestions inside each cat’s existing card; use **Approve suggestion** or **Discard** there. **Trainer activity** in the top-right shows observation progress, scheduler checks, the review model, in-progress reviews, last results and the next eligible review. Its links open each cat’s review and visible history. The key is stored in this tab’s session storage, survives refresh, and is revalidated against the engine before coaching is revealed. Temporary connection failures retain it for retry. **Exit trainer mode & forget key** clears access; invalid keys are also cleared. The key is sent only to the engine for trainer access and review actions. Never enter your Vercel API key in the dashboard. Use HTTPS if exposing the dashboard beyond localhost.

The first review needs at least an hour of observations and 30 model decisions. Each cat gets at most one attempt per rolling 24 hours and per UTC day, including failures and restarts. Reviews summarize the previous 24 hours: WAIT versus HOLD, menus offering only WAIT, entry blockers from the same checks that build the trading menu, model failures, risk vetoes, fills, current portfolio, and market conditions. Only this scoped trading evidence and strategy facts go to the review model; credentials and full configuration do not. Insufficient evidence waits; unavailable providers produce a visible failed review and retry at the next daily opportunity. Closed experiments stop coaching.

The coach can recommend **no change**, or one bounded adjustment to minimum trend score, action probability, or conviction. Each proposal includes an explanation, exact before/after value, and downside. Changes must have matching blocker evidence and pass server validation. Trend and conviction move at most one point per review and one point from the original settings. Action probability stays within 50–95%, changes by at most five percentage points, and stays within ten percentage points of the original setting. Stops, loss limits, position sizes, fees, cooldowns, entry caps, permitted coins, breakout confirmation and exit rules cannot be rewritten. Waiting alone does not justify relaxing rules.

**Approve suggestion** persists the approved threshold in the run database and updates the next decision without a restart or immediate order. Acceptance is refused while the cat holds a position, after settings change, or after the suggestion expires (24 hours). **Discard** records your decision without changing settings. **Restore original thresholds** clears all coach adjustments for that cat. In-flight model decisions from older settings are discarded. Accepted settings persist until restored; explicit changes to the three original threshold environment values take precedence on restart. The dashboard shows current effective values and recent review history; complete review and approval records remain in SQLite.

Read access remains public (`GET /coach` and the snapshot). `POST /coach/unlock` validates trainer access without changing a review. `/coach/accept`, `/coach/decline`, and `/coach/reset` require the separate owner bearer key and a JSON body. The gateway credential is never served to the browser.

## LM Studio and Nimble 9B

The LM Studio integration uses only the documented [`POST /v1/systemone`](https://lmstudio.ai/docs/developer/jev-compat/systemone): an exact-menu `choice` and a four-level ordered `score`. It checks the loaded model through [`GET /api/v1/models`](https://lmstudio.ai/docs/developer/rest/list) before every inference request. The selected instance must be advertised as a **GGUF decision model**. Unloaded models fail closed; Catfolio does not load a replacement.

1. Update LM Studio using its application updater. In **LM Runtimes**, update/select a llama.cpp runtime with native decision-model support. CLI equivalents are `lms runtime ls`, `lms runtime update`, and `lms runtime select`. We have not established a first compatible LM Studio build; the connection test, rather than a guessed version number, is the compatibility gate.
2. Download a decision-enabled Nimble conversion, such as [ggml-org/Bespoke-Nimble-9B-v3-GGUF](https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF). This model card specifically identifies `/v1/systemone` as its API. A regular Qwen3.5-9B checkpoint, an unmerged adapter, or a generic chat conversion is not interchangeable. Use the decision model's bundled calibration metadata. The published weights are CC BY-NC 4.0; check the model's own license for your use.
3. For the **RTX 4090 / 24 GB VRAM**, use a compatible CUDA llama.cpp runtime and start with the Q8_0 artifact (about 9.53 GB of weights). For the **M4 / 64 GB unified memory**, use the compatible Metal llama.cpp runtime and the same GGUF. Q4_K_M is about 6.32 GB; BF16 is about 17.9 GB. These are weight sizes, not measured total runtime memory. Start at 4096 context and concurrency 1; use LM Studio's resource estimate and measure actual latency/memory. MLX inference for this endpoint/artifact has not been verified and is intentionally not accepted here.
4. Start the server from Developer → Local Server, port 1234, or `lms server start --port 1234`. Load **one** model instance. Find the downloaded key with `lms ls`, then substitute it below:

```sh
lms runtime ls
lms ls
lms load '<downloaded-Nimble-GGUF-key>' --context-length 4096 --gpu max --estimate-only
lms load '<downloaded-Nimble-GGUF-key>' --context-length 4096 --gpu max --identifier catfolio-nimble-9b
lms ps
```

Set `LM_STUDIO_MODEL=catfolio-nimble-9b` **only if you used that identifier**. If loaded through the UI, copy the actual `loaded_instances[].id` from `GET /api/v1/models` or `lms ps`. There is no assumed model name of `nimble`. If server authentication is enabled, set `LM_STUDIO_TOKEN` to the local token. Never put tokens in URLs.

Record the app build, selected runtime revision, artifact repository/revision, quantization, file SHA-256 and load settings. For example, use `shasum -a 256 /path/model.gguf` on macOS, `sha256sum` on Linux, or `Get-FileHash -Algorithm SHA256` in PowerShell; paste the identity into `LM_STUDIO_ARTIFACT`. Declared versions are operator supplied, not independently authenticated. Each decision records them along with actual model metadata/load configuration returned by LM Studio. Missing provenance is explicitly stored as `unrecorded`.

```sh
pnpm local:check
```

This command inventories loaded instances, exercises **both** typed responses, validates the schema/probabilities/score/identity, returns nonzero when unsupported, and saves `data/local-connection-check.json` (no token). With no loaded model it performs a read-only route probe with a nonexistent identifier. It never downloads, loads, switches models, generates chat text, or sends orders. An “unexpected endpoint” response requires an application update; an unsupported-decision-model response also requires a compatible inference runtime and artifact. If an updated LM Studio still fails, this fork cannot trade with that combination: preserve the diagnostic, report it upstream, and wait for support. No integration success is claimed until this test passes on your machine.

Requests preserve model-file scoring temperatures: **no `temperature=0` override**. Choice probabilities and score probabilities must contain every submitted option/level, be finite in [0,1], and sum to 1 within 0.001. Confidence must be finite in [0,1]; expected conviction is [0,3] and must agree with its distribution. Conviction gates use the continuous expected score, without rounding up to a stronger level. The score legend must match the ordered rubric. Responses with a different model identity fail closed. Empty menus and singleton opening menus are rejected locally. A singleton WAIT/HOLD is recorded as a deterministic rules-only action with no inference latency. Menus are never silently truncated.

### Keep the host awake

Explicitly loaded models have no TTL by default ([LM Studio loading/TTL documentation](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)). Leave the model loaded, avoid setting `--ttl`, keep LM Studio running, and do not let other apps evict/swap that instance. On the Mac, run `caffeinate -i pnpm start` instead of `pnpm start`, leave the lid open and connect power. On Linux, use `systemd-inhibit --what=sleep --why='Catfolio paper run' pnpm start`. On Windows, run Node/pnpm natively in PowerShell, use `Copy-Item .env.example .env` instead of `cp`, and set the plugged-in power policy to stay awake. Keep the engine terminal alive; a terminal multiplexer is useful over SSH. CUDA/Metal throughput and an actual full overnight run still need hardware verification.

## Two independent risk budgets

`TOTAL_START_EQUITY_USD=200` is the only starting bankroll setting. Allocations default to 50%/50% and must sum to 100%. Each cat owns its cash ledger, single position, realized/unrealized P&L, fees, funding, day loss baseline, entry counter, and drawdown history. There are no transfers or automatic top-ups. Names and text profiles are editable; identities remain exactly `tiger` and `mochi`.

| PAPER default | Tiger | Mochi |
|---|---|---|
| Universe | BTC, ETH, SOL | BTC, ETH |
| Style | 5m breakout / 15m trend | 15m entries / 1h trend |
| Directions | Long only | Long only |
| Maximum notional / own equity | 50% | 50% |
| Initial stop risk budget / own equity | 0.5% | 0.25% |
| Daily loss stop | 5% | 2% |
| New entries / UTC day | 8 | 4 |
| Minimum entry cooldown | 15 min | 30 min |
| Maximum holding time | 2 hours | 6 hours |
| Maximum spread | 10 bps | 3 bps |
| Minimum 24h volume | $1 million | $10 million |
| Minimum action probability | 0.55 | 0.70 |
| Minimum conviction level | 1 | 2 |

The active strategies are documented in [Catfolio strategies](strategies/CATFOLIO.md). The original [Breezy](strategies/BREEZY_BEE.md) and [Bizzy](strategies/BIZZY_BEE.md) documents are preserved as historical references.

**Tiger: fast intraday breakout.** A completed five-minute close must exceed the high of the preceding twelve five-minute candles, with positive 15-minute momentum and a 15-minute trend score ≥3. No daily breakout or four-hour gate remains. Skip chasing more than 25% of the preceding hour's range; funding must be known and ≤0.03%. Initial stop is 2 × five-minute ATR, with channel trailing, lost-trend exit and a two-hour maximum hold.

**Mochi: hourly trend following.** Use hourly trend score ≥4 with no bearish channels, positive 45-minute momentum from completed fifteen-minute candles, and strongest BTC/ETH selection. Initial stop is 2 × hourly ATR. Score and correctly annualized 90-hour volatility determine sizing. Channel trailing, lost-trend exits, a three-point one-time half-trim and a six-hour holding limit manage positions.

Both use nine shorter Donchian lookbacks: 3, 5, 8, 12, 18, 24, 36, 48 and 72 bars. The feed requests 100 five-minute, 200 fifteen-minute and 200 hourly candles per coin; unfinished candles are excluded and missing/stale histories block entries. Before entry, the initial ATR stop distance must exceed twice estimated round-trip fees, spread and slippage. This filters tiny movements; it does not forecast profitability. More frequent opportunities can also mean more false signals and trading costs. Strategy version `catfolio-3-intraday` separates the new audit records from the previous daily/four-hour rules.

See `.env.example` for tunable parameters. Confirmed-bar, trend, funding and no-chase filters are conservative experimental adaptations, not backtest-optimized claims. Both strategies permit cash. The dashboard's “How … trades” panels show rules from the effective configuration.

Sizing floors contracts to the exchange lot size after taking the minimum of the cat's equity-based notional cap, stop-distance risk budget (including estimated entry/exit fees), and available capital. Only linear OKX EEA USD-margined X-Perps are supported; contract value/multiplier and minimum lot specifications come from the exchange. Undersized trades are skipped, never rounded up to make a trade happen. No martingale, averaging down, adds, forced entry, “never flat”, position switching, or exposure-increasing rebalance exists in the active engine. The active cat brains implement intraday sizing, ATR stops, channel trails and holding limits; only `catBrain(tiger)` and `catBrain(mochi)` are scheduled.

**Stop-distance risk is a sizing estimate, not a maximum realized loss guarantee.** Gaps, spread changes, latency and slippage can exceed it. The loss/entry/fee limits are independent per cat. Entry, fee and cooldown caps never prevent fresh risk-reducing exits. Both cats can WAIT while flat or HOLD/CLOSE while positioned; even a whole night without entries can be correct. Stops and loss limits override HOLD.

An action's probability is **not** the probability of profit. Conviction scores describe evidence strength, independently of the action choice. The defaults (especially the stricter 0.70 probability gate inspired by the earlier trend strategy) require evaluation with Nimble; Jev-era calibration cannot be assumed to transfer.

## Scheduling, ledger and reporting

- Model cadence: 60 seconds per cat. One shared client, concurrency 1 by default (maximum 2), at most one outstanding decision per cat. The timeout includes queue time and cancels HTTP requests. Timed-out and stale responses are discarded. Server-side compute cancellation ultimately depends on LM Studio.
- Protection: separate five-second loop, fresh ticker checks and deterministic stops/loss limits. A slow/unloaded/offline model prevents new exposure without holding this loop. Before a returned action executes, position identity, current setup, ticker/indicator freshness, spread, limits and sizing are checked again.
- SQLite WAL: decisions before orders; fill, fees, position/stop, entry count and cash persisted in one transaction. Deterministic order IDs and a unique execution constraint prevent repeats. A pending uncommitted paper order on restart is marked rejected; a simulated fill either committed with its complete ledger state or had no persistent effect.
- `decisions.audit_json` records input state, full market snapshots, exact menu, strategy/rubric versions and text, configuration/provenance, loaded model metadata, choice and score distributions, and resulting code action. `pnpm replay ID --infer` submits that request again without execution; identical inference is not guaranteed across artifacts, runtimes or hardware. Choose the original model and inspect recorded settings before replaying.
- Morning reports compare the whole run, including start/end equity, net return, realized/unrealized P&L, fees, funding, spread/slippage, maximum observed drawdown, time exposed, entries/exits/vetoes/model failures, and nearest-rank median/p95 request latency (queue included). Rules-only decisions and preflight configuration failures are excluded from latency samples. CLI reports are read-only and do not fetch prices. The dashboard uses current engine state.

The paper simulator fills the entire requested lot at bid/ask plus **2 bps adverse slippage**, charges **0.05% taker fees** each way, and estimates funding at 00:00/08:00/16:00 UTC using the observed current funding rate. Spread + extra slippage is reported as execution shortfall versus mid and is already reflected in P&L; do not subtract it twice. Contract funding intervals can differ, historical funding across downtime is not backfilled, and there is no order book depth, queue position, partial-fill, liquidation or market impact model. USD settlement is treated as USD; collateral conversion/depeg effects are absent. Protective checks are software checks, not exchange-hosted stop orders. Cash is the collateral ledger, not spot proceeds. Drawdown is measured at observed quotes/fills, not every exchange tick. Do not interpret one profitable night as a durable advantage.

## Docker: bot container, LM Studio on host

All images build locally; no upstream beebots image is pulled. Compose has a fresh `catfolio-data` volume and **forces PAPER mode** even if `.env` has other mode settings. It keeps the existing Caddy dashboard/reverse proxy and nightly SQLite `.backup` sidecar. The dashboard binds to loopback, port 8088.

1. Complete `.env` and LM Studio setup above.
2. Set `LM_STUDIO_HOST_ORIGIN=http://host.docker.internal:1234` in `.env`. Inside a container, `127.0.0.1` points to the container. Docker Desktop supplies this hostname; Compose adds `host-gateway` for Linux. LM Studio may need “Serve on Local Network” / a host-reachable bind address; restrict access with the host firewall and use its optional authentication token. Do not expose this port publicly.
3. Build, test the host connection from the container, then start:

```sh
docker compose build
docker compose run --rm engine node dist/tools/local-check.js
docker compose up -d
# open http://127.0.0.1:8088
docker compose logs -f engine
```

Optional local profiles inside the volume:

```sh
docker compose run --rm engine node dist/tools/setup.js
# Edit /data/catfolio-settings.json in the volume, then restart the engine.
```

Morning/close/pause:

```sh
docker compose exec engine node dist/tools/report.js
docker compose exec engine node dist/tools/paper-stop.js
# Wait until http://127.0.0.1:8088/snapshot reports closed.flat=true.
docker compose stop
# To resume a PAUSED run (one not closed by paper-stop):
docker compose up -d
```

To change the Docker starting bankroll or allocations, first stop the engine and preserve its existing run. Set a **new** `DOCKER_DB_PATH` in `.env` (for example `/data/catfolio-night2.sqlite`), then run `docker compose up -d --force-recreate engine`. Keep the path under `/data` so it persists in the volume. Native `DB_PATH` is separate; Compose uses `DOCKER_DB_PATH`. Switching filenames creates two fresh accounts; it never tops up the old ones.

Do not use `down -v` on an experiment you want to keep. Backups live in the same volume, `/data/backups`; copy important runs elsewhere. To create an entirely separate Docker run, use a new Compose project, e.g. `docker compose -p catfolio-night2 up -d` after stopping the first stack (or choose another dashboard port). The host still needs to stay awake; keeping the container alive cannot prevent host sleep.

## Demo/live status and safeguards

This task did not place real or demo orders and does not enable live trading. Native exchange adapters remain for future manual work. Non-paper modes require `DRY_RUN=false` plus an explicit mode; live additionally requires the unchanged `LIVE_ACK=I-ACCEPT-REAL-MONEY-RISK` and **two distinct sub-account credential sets**, `TIGER_OKX_API_*` / `MOCHI_OKX_API_*` (or `*_OKX_DEMO_API_*` for demo). The live size ramp remains. No third key is read. Account permissions and actual distinct sub-account IDs must be checked with the read-only `pnpm keycheck` before any future use.

Private exchange behavior was not tested here. Retained reconciliation compares local positions/fees with OKX. Unknown/sent private orders block resending and require reconciliation/operator investigation; non-paper cash/collateral reconciliation and unknown-order recovery need separate validation before any demo/live experiment. The first run described here is strictly PAPER.

## Development and attribution

```sh
pnpm test                        # retained component tests + new safety tests
pnpm test:integration            # local HTTP mock and engine/restart tests
pnpm typecheck
pnpm lint
pnpm build
pnpm --dir dashboard build
docker compose config --quiet
```

[Validation notes](docs/VALIDATION.md) distinguish mock tests, real public market data, the unsupported installed LM Studio probe, and remaining hardware work. No framework was added. The old Hive/Beekeeper/OpenAI product surfaces and their obsolete tests were removed; their history remains in Git. Active strategy adaptations are covered in `test/cat-strategies.test.ts`; historical helpers retain regression coverage in `test/legacy-strategy-components.test.ts`. They cannot create additional trading identities.

Original project: Mike Russell / Creator Magic, [beebots](https://github.com/imikerussell/beebots), MIT. Upstream [LICENSE](LICENSE) is preserved. Vendored OKX Agent Trade Kit code retains [its MIT license](src/okx/kit/LICENSE). Cat SVGs are bundled local artwork. Model weights have their own license. This is experimental software with no warranty and no investment advice.
