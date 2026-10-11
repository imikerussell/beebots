# Catfolio 🐈

Two independent cats, one selectable decision provider, and deterministic risk controls. A fork of [Mike Russell's beebots](https://github.com/imikerussell/beebots), running its original engine lifecycle, an active long/short Dark Wall-E brain and the original Breezy brain, source risk behavior, OKX public-data client, indicators, SQLite ledger, execution adapters, event stream, and equity chart. Paper trading is the default. LM Studio / Nimble is the default and requires no paid cloud AI. Jev is an optional, explicitly selected billed cloud backend. The dashboard includes locally served generated cat portraits. No leaderboard reporting, Zapier, or remote rule rewriting.

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

The first scheduled trading tick is after 10 seconds by default (`DECISION_INTERVAL_MS=10000`). Protective checks run within the same serialized tick; an outstanding model request delays the next tick. The dashboard shows PAPER, each cat's allocated capital/equity, returns, positions/stops, costs, exposure, drawdown, recorded action/veto, and local inference requests/latency. “Local setup” explains the file-based setup; no keys are entered in the browser. “Morning report” opens the comparison and offers a JSON download.

The desktop dashboard adapts to laptop viewport height, with compact portfolio cards, a trainer update and one strategy-watch row per cat. Strategy summaries are removed from the overview. Click a trainer update, watch row, recorded action or engine status for details; mobile layouts stack naturally.

The public **Decision stream** previews the latest two decisions; **Decision history** opens up to 200 recorded decisions received over `/events` (SSE), including WAIT/HOLD, rules-only decisions, blocked actions, protective exits, and model failures. Expanded rows show action probabilities, response time, and total cat P&L at decision time when available; approval by risk checks is not confirmation of a fill. Filter by cat or pause the view to read without pausing trading. The connection indicator and last-decision age distinguish a quiet stream from a disconnected one. Recent decisions are merged from `/history?type=decision&n=200` on load and reconnect without duplicate rows; older events without the new fields still display. Streams send heartbeat events every 15 seconds; the dashboard reconnects if no event arrives for 45 seconds.

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

**Pause/resume the same run:** Ctrl+C (or SIGTERM) gracefully saves the ledger and cancels outstanding inference. It does **not** flatten positions. `pnpm start` resumes the same positions, stops, balances and daily counters, then resumes the source trading schedule. Stops and loss limits take precedence over a proposed trade in source risk processing. Stops cannot run while the process/computer is off. The report excludes unobserved downtime from exposure duration; funding during downtime is not reconstructed.

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

## Strategy trainer

The trainer automatically reviews each cat every four hours through the Vercel AI Gateway. Set `COACH_ENABLED=true` and `AI_GATEWAY_API_KEY`; `COACH_MODEL` selects the review model. The first review requires at least one hour and 30 recorded observations from a compatible strategy version. Rules-only waits count as observations, and provider failures also count toward the four-hour review cooldown. Closed experiments stop coaching. Review evidence excludes retired or unidentified strategies and future-dated observations; filled entries are attributed through their recorded decision. Good's unchanged source-engine history remains compatible after the active-momentum upgrade. Historical review records retain their original evidence.

The public **The Trainer** card on the right shows the next round, rewrite count, latest assessment and recent history. It shows the latest review's observation/wait/entry/error counts alongside current strategy data: coin coverage, entries today, P&L and long/short signal counts and the strongest momentum signal. Click the card or a history item for the rules, reasoning, uncertainty, recorded blockers and per-coin market evidence. Offline data is labeled. There is no trainer login or approve/discard workflow.

The prompt lives in `src/coach-prompt.ts`. Reviews return exactly `idea`, `rules`, `coins`, `reason`, `quip` and `note`. The server validates the schema, allowed coins and configuration revision, then persists and applies rules/coins automatically. Unchanged rules and coins produce a **no change** review without replacing the active overlay. Reviews that finish after shutdown, experiment closure or a settings change expire without applying. Old manual proposals expire on upgrade; review history is preserved.

JSON fences, whitespace and common typographic punctuation are normalized before validation. Malformed JSON, truncated output or invalid field formatting receive one automatic repair attempt with fixed validation feedback and a larger output allowance, within the original 60-second review deadline. A repaired response must still pass every validation check. Persistent failures identify the response problem and affected fields without storing provider bodies or unknown field names. Existing failures cannot recover details that were not recorded.

The decorative `quip` caption is cleaned separately: accents, emoji, quotes and hashtags are removed or normalized. If it is still too long, empty or missing the trainer-facing cat name, the app supplies a short caption using that name instead of rejecting the strategy or making another model call. Missing or non-string fields remain invalid. This never repairs or replaces the proposed rules or coin list; all strategy checks still apply. Existing failed reviews remain in history, and the fix applies to future scheduled reviews.

Reviews use both cats' last-24-hour scorecards, current rules, fixed playbooks, observable fields, menus, market eligibility, entry blockers, risk vetoes and model failures. Waiting alone is not a reason to force a rewrite. Rules contain 2–4 short ASCII sentences (400 characters maximum). Coins must be a subset of the baseline universe: BTC/ETH/SOL/HYPE/XRP/DOGE/ADA/LINK/AVAX/SUI/LTC/BCH for Dark Wall-E and BTC/ETH for Good Wall-E. An empty coin string means all baseline coins, including previously excluded ones.

Applied changes invalidate cached strategy instructions and affect subsequent model decisions. They never place an order or change a held position's stop. Code owns entry eligibility, stops, sizing, leverage, cooldowns and loss/trade limits. Both cats can trade long and short. Rules stay active until replaced or restored, and explicit baseline edits take precedence on restart. Dark Wall-E's old daily-breakout overlays are retired on upgrade; Good Wall-E's compatible overlays are preserved.

`GET /coach` and the snapshot remain public. The separate `COACH_ADMIN_TOKEN` is optional for automatic reviews; it protects the owner-only `POST /coach/reset` recovery endpoint. Reset clears the rules/coin overlay without placing an order. Legacy unlock/accept/decline routes remain authenticated for compatibility, but new reviews never await approval. Gateway credentials are never served to the browser.

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
| Universe | BTC, ETH, SOL, HYPE, XRP, DOGE, ADA, LINK, AVAX, SUI, LTC, BCH | BTC, ETH |
| Style | Active intraday momentum | Breezy 4-hour Donchian trend |
| Directions | Long and short | Long and short |
| Default maximum notional | 2x equity with 3% margin headroom, capped at $700 | Same, with score and volatility sizing |
| Daily loss stop | 8% | 8% |
| New positions / UTC day | 12 | 3 |
| Discretionary opening cooldown | 5 min | 240 min |
| Position management | Hold / close / reverse / ATR trail / 2-hour time exit | Hold / add / trim / flip / switch / rebalance |
| Maximum spread | 5 bps | 5 bps |
| Forced entry | Never | Strongest directional trend when flat, subject to data/model availability and caps |

Dark Wall-E now runs [active intraday momentum](strategies/ACTIVE_WALL_E.md) in `src/bees/active-bizzy.ts`. The historical [daily Bizzy](strategies/BIZZY_BEE.md) implementation remains for reference and regression tests. Good Wall-E keeps the original [Breezy](strategies/BREEZY_BEE.md) strategy. See [engine provenance and integration boundaries](strategies/CATFOLIO.md).

Dark offers LONG when the one-hour return is at least max(0.1%, 0.25 × 15-minute ATR%) with nonnegative MACD, and SHORT on the mirrored negative signal. All signals use completed 15-minute candles; the daily breakout level is irrelevant. The model chooses among qualified markets or WAIT, with at least decent conviction required to open. Fresh data, volume and spread checks still apply. HOLD and CLOSE are available while invested; FLIP is available when the opposite signal qualifies. Initial stops use `TIGER_STOP_ATR_MULT` (default 1.5) times 15-minute ATR, start trailing after +1R, and time exits use `TIGER_MAX_HOLD_MINUTES` (default 120). There are no forced Dark entries.

The new default daily entry limit is 12, opening cooldown is five minutes, and fee budget is $3. Existing explicit leverage, notional and daily loss limits remain in force. More available signals and entries do not guarantee a trade count or profitability. Update the deployed environment too: an old `TIGER_MAX_ENTRIES_PER_DAY=1` still overrides the new default. `.env.example` documents the active settings.

The feed supplies completed 15-minute indicators for Dark and 400 four-hour candles for Breezy. The original serialized engine tick defaults to ten seconds, including protection. Strategy version `catfolio-6-active-momentum` identifies this change. Source lifecycle and risk logic remain in `src/engine.ts` and `src/risk.ts`; provider, trainer and dashboard integration live in `src/catfolio-engine.ts`.

Accounts, positions, existing stops, order/fill history and balances survive the upgrade. No top-up or history reset occurs. The shipped daily-breakout rules migrate to the active defaults; custom owner rules remain explicit overrides. Dark's incompatible coach overlays are retired once at the version boundary; Good's compatible overlays survive. Existing Dark positions become subject to the active strategy's time exit and trailing rules.

## Scheduling, ledger and reporting

- Trading cadence: ten seconds by default, using the upstream serialized tick. One shared provider client, concurrency 1 by default (maximum 2). The provider timeout includes queue time and cancels HTTP requests. Server-side compute cancellation depends on the provider. Empty menus, a lone legal hold and already-benched trade/fee caps can avoid model calls.
- Protection: source stops/loss limits execute within the same tick. A slow model can delay subsequent checks until its request finishes or times out. `PROTECTIVE_INTERVAL_MS` and `MAX_DECISION_AGE_MS` no longer govern the engine; remove them from deployed configuration. Set `DECISION_INTERVAL_MS=10000` to adopt the source cadence if the deployment still specifies 60000.
- SQLite WAL: source decisions, orders, fills and account saves retain the original processing order. Fill and initial stop/account persistence are not atomic together; the former replacement-engine crash guarantee does not apply. Interrupted paper orders are marked rejected on restart, without inventing a fill or topping up capital.
- `decisions.audit_json` records state, market snapshots, menu, strategy/rubric versions and configuration. Decision rows retain the source result, probabilities and resulting action. `pnpm replay ID --infer` submits a recorded request without execution; identical inference is not guaranteed. Choose the original model and inspect recorded settings before replaying.
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
