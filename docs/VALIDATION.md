# Catfolio validation — 2026-10-09

## Verified locally

Final automated result: **181 tests passed across 17 files**. `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --dir dashboard build`, `docker compose config --quiet`, and engine/web/backup Docker builds all passed. Native checks used Node 25; the Docker build and running engine used the pinned Node 22 image.


- Mock HTTP tests exercise `/api/v1/models` plus documented `POST /v1/systemone` choice and ordered score shapes, finite/range/sum/legend validation, model identity, errors, unavailable routes, unloaded models, deadlines/cancellation, shared concurrency, and empty/singleton menu behavior. **These are not real inference tests.**
- Engine tests cover two isolated funded accounts, abstention, stop-risk/fee/notional/lot caps, loss/entry/cooldown differences, fresh risk-reducing exits, five-second protective scheduling during pending inference, changed/stale decisions, order rejections, atomic ledger commits, restarts and duplicate prevention.
- Retained tests cover indicators, historical pure strategy components, ledger math, public OKX parsing/caching/rate limits, redaction and other useful infrastructure.
- `pnpm snapshot` successfully fetched current public OKX EEA data for BTC/ETH/SOL with no credentials or orders. A missing ninth trend lookback was found in the inherited 300-bar fetch and corrected with pagination to 400 bars.
- `pnpm run setup` was executed against a temporary settings path and produced exactly Tiger/Mochi profiles. Use **`pnpm run setup`**, because `pnpm setup` is pnpm's own installation command.
- The locally built Docker stack was started in an isolated `catfolio-verify` project on port 18088. Its dashboard and side-by-side report were visually inspected. Snapshot/report endpoints showed PAPER, two $100 accounts, and zero orders.
- Graceful restart and SIGKILL/restart both recovered that run without additional funding or orders. The process lock detects reused Linux PIDs via process start time and boot identity.
- The paper-stop command closed the run; restarting retained the closed state. The verification stack was then stopped/removed without deleting its historical volume. It is not an overnight trading result.
- A container-to-host LM Studio probe reached `host.docker.internal:1234` and reported the same unsupported endpoint and missing Nimble model. **Network connectivity passed; inference compatibility did not.**

## Optional Jev provider switch

`DECISION_PROVIDER=lmstudio|jev` selects one provider for both cats. Eleven mock HTTP tests verify the Jev request/response contract, selection, authentication, missing-key fail-closed behavior, no fallback/retry, malformed scores, HTTP errors/backoff, cancellation, cost estimates, queued budget checks and budget persistence/day rollover. An engine/report test checks that provider identity is recorded, credentials are excluded, and estimated hosted costs do not reduce paper trading capital.

Both adapters share the bounded/cancellable System One transport and strict response validator. Jev uses the documented TypeSafe HTTP endpoint directly, so no new SDK dependency was added. A subsequent read-only Jev connection probe after a key was supplied returned HTTP 401 (authentication failed). Successful actual Jev inference remains unverified; use `pnpm provider:check` after correcting the credentials. Daily costs are estimates from returned usage, not guaranteed invoice totals or account-wide hard limits.

## Real LM Studio compatibility probe: FAILED / unsupported installed combination

Observed via local CLI, application metadata and HTTP:

- Application: LM Studio **0.4.9+1**.
- CLI commit: **8d3f370**.
- Selected GGUF engine: **llama.cpp-mac-arm64-apple-metal-advsimd@2.13.0**.
- Selected MLX engine: **mlx-llm-mac-arm64-apple-metal-advsimd@1.10.1**.
- `lms ps`: **No models are currently loaded**.
- Downloads: Qwen3.8-27B MLX and Nomic embedding GGUF; **no Nimble artifact**.
- `POST http://127.0.0.1:1234/v1/systemone`: HTTP 200, `{"error":"Unexpected endpoint or method. (POST /v1/systemone)"}`.

Thus no Nimble choice/score inference could be run. The installed HTTP server does not expose the documented route. This is separate from, and additional to, the missing Nimble artifact. No chat model was substituted and no cloud provider was called.

Required follow-up: update LM Studio and its llama.cpp runtime to a build supporting native decision models; load a decision-enabled Nimble 9B GGUF; select its actual loaded identifier; record build/runtime/artifact revision/hash; run `pnpm local:check` until **both choice and score** pass. The official docs do not establish a tested minimum build here, so none is invented.

## Hardware verification still needed

- Actual Nimble choice and score distributions with the selected GGUF and updated LM Studio runtime.
- RTX 4090 CUDA and M4 Metal resident memory and median/p95 latency; check that queue + inference fits the configured timeout and stale-response limit.
- One complete awake overnight run, recording the exact configuration and model provenance.
- Operational pause/resume and a stopped/unloaded model on the chosen hardware.
- Evaluate probability/conviction thresholds; this is not a calibrated trading-profit predictor.
- Any demo/live exchange behavior is outside this paper verification. No private order was placed.

## Important limits

Paper execution uses bid/ask plus fixed adverse slippage and taker fees. Funding uses an approximate eight-hour schedule and current rate; downtime is not backfilled. There is no depth, queue, market impact, partial-fill or liquidation simulation. A stopped engine provides no protection. A profitable night is not evidence of a durable advantage.

## Restored strategies (catfolio-2-breezy-bizzy)

- Mochi reuses Breezy score/volatility sizing, 4h ATR stops, stronger-coin selection and channel trailing. Tiger reuses Bizzy day-open stops and deterministic 23:59 UTC exits with confirmed daily breakout entries. Original strategy documents are restored as historical references.
- Eleven focused strategy/input tests cover nine-channel rising/falling/flat histories, strongest-coin ties, actual volatility-dependent order sizes, missing volatility, four-hour stops, one-time trim menus, lost-trend exits without inference, daily breakout confirmation/chasing/funding/time filters and complete previous-day data.
- An additional engine test fills a Mochi entry, records its score, executes a partial trim, restarts, verifies no duplicate trim, and performs the deterministic trend-loss exit. Existing isolation, slow inference/protection and restart tests remain passing.
- A real, read-only public OKX snapshot at 21:30 UTC on 2026-10-09 supplied all nine horizons plus valid daily breakout levels for BTC/ETH/SOL. BTC/ETH scores were -4 and SOL -6; both cats correctly had only WAIT. This did not call an AI provider or place orders.
- These checks establish executable mechanics and data compatibility. No historical profitability backtest, holdout optimization, or overnight performance result has been established for these adaptations.
- Rebuilt and restarted the active Docker engine/web successfully; the engine is healthy in PAPER mode, preserving $250 per cat and zero orders. The refreshed dashboard was visually checked with both strategy rule panels expanded. Jev remains selected; no successful Jev inference is claimed by this strategy validation.
