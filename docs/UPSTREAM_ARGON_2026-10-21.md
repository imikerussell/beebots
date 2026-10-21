# Upstream Argon migration

Catfolio now supports the trading changes from
[beebots `6cf999a224e67c7e2b6a74be0a064c409523d519`](https://github.com/imikerussell/beebots/commit/6cf999a224e67c7e2b6a74be0a064c409523d519).
This imports the two upstream commits after our shared `6d3fe0d` baseline.
The existing repository, two cats, dashboard, local portraits, reports, trainer,
Docker packaging and historical databases are retained. The trainer is benched with upstream strategies: no reviews, automatic rule changes or restored trainer experiments, even when old coach flags are enabled. Its history remains accessible through the dashboard’s compact BENCHED indicator. No new GitHub fork is needed.

## What changed

- Gemini `generateContent` chooser, using upstream's `gemini-4-argon` model setting.
- Worst-case spending reservations persisted before requests; output and thinking tokens
  count toward estimates. Unknown billing retains the reservation. Unsettled reservations
  survive restart. Price settings must be positive.
- Separate call pacing per cat, default 60 seconds. Snapshot reuse expires with that
  interval rather than replaying the same cached answer forever.
- Upstream code chooser when the selected Gemini backend has no key, no remaining
  budget, an error, a timeout or an invalid choice. Every decision records who chose it
  and the fallback reason. Code's invented weights are not shown as model confidence.
- Independent protective watch every `min(DECISION_INTERVAL_MS, 2000)` milliseconds.
  Per-cat execution locks and exit generations prevent duplicate orders or an old model
  answer acting on a position that has already been closed.
- Argon's Breakout, Trend and Momentum strategy implementations, with upstream behavior
  tests. The two current identities map to Breakout (Dark) and Trend (Good); Momentum is
  retained as an available internal style, without creating a third funded identity.
- Gemini hub animation at the top of the existing sidebar, connected to the two cats.
  This adapts the panel observed on the live beebots.tech site; that panel was absent
  from the published GitHub snapshot. Activity comes from recorded model decisions.
- Effective configuration inspection and long-equity-series chart fix.

The upstream Setup/OpenAI portrait generator, public Hive and Zapier Beekeeper are not
restored: Catfolio keeps its existing setup, portraits and trainer. Jev and LM Studio
remain selectable providers.

## Start a separate paper run

Stop the previous process before changing a running installation. Preserve its database,
backups and configuration. Prefer a new run database so old and new strategies are not
mixed in one performance curve. This migration does not rewrite `.env` or restart a deployment.

```dotenv
DECISION_PROVIDER=gemini
STRATEGY_ENGINE=upstream
GEMINI_API_KEY=your-google-key
GEMINI_MODEL=gemini-4-argon
GEMINI_DAILY_USD_CAP=3
GEMINI_MIN_INTERVAL_MS=60000
GEMINI_TIMEOUT_MS=3000
GEMINI_USD_PER_MTOK=4
GEMINI_USD_PER_MTOK_OUT=20
DRY_RUN=true
MODE=paper
DB_PATH=./data/catfolio-argon-paper.sqlite
DOCKER_DB_PATH=/data/catfolio-argon-paper.sqlite
```

The model name and token prices are upstream defaults, not a claim that this key can
access that model or that those prices match your invoice. Check Google's current
[model access](https://ai.google.dev/gemini-api/docs/models) and
[pricing](https://ai.google.dev/gemini-api/docs/pricing). A paid inference request was
not made during development. `provider:check` makes a potentially billed request and
fails if it gets code fallback instead of a real model answer; it never places an order.

Old environment values override the new defaults. In particular, remove or deliberately
set these entries when taking Argon's rules:

| Setting | Dark | Good |
|---|---:|---:|
| `*_MAX_ENTRIES_PER_DAY` | 4 | 2 |
| `*_COOLDOWN_MINUTES` | 30 | 240 |
| `*_FEE_BUDGET_USD_DAY` | 1.20 | 0.75 |
| `*_STOP_ATR_MULT` | 2 | 2 |

Good's upstream entry probability threshold defaults to 0.55 and conviction to 1.
Dark has no upstream conviction gate. Catfolio still applies its owner-configured
stop-risk sizing, per-cat notional limits, loss limits, market freshness and order checks.
This is an intentional difference from unmodified upstream sizing, not exact order parity.

```sh
pnpm effective-config .env --diff strategies/ARGON_INTENDED.json
pnpm provider:check
pnpm build
pnpm --dir dashboard build
```

Inside Docker, after recreating the engine with the intended environment:

```sh
docker compose exec engine node dist/tools/effective-config.js --runtime --diff strategies/ARGON_INTENDED.json
```

Runtime inspection uses the container process's environment and settings file. The file
form is only a simulation of that file and loader defaults; it cannot see your deployment
manager's variables. Both forms show key presence without key values. The reference has
three upstream styles, so the absent third funded identity remains an expected difference.
Catfolio's existing Arcane deployment files remain authoritative for deployment.

## Behavioral differences to understand

**Code fallback can open positions.** It chooses from legal menus by fixed priorities and
does not read free-text rules. Coin restrictions and risk checks still apply. A rule such
as “never trade” is not a code-level trading prohibition. The dashboard labels these
decisions CODE and explains why Gemini did not answer.

Gemini's confidence is self-reported, not the typed action distribution Jev or Nimble
returns. Synthetic menu weights are used internally for upstream-compatible gates, but
the dashboard does not present them as a measured probability distribution or chance
of profit.

`STRATEGY_ENGINE=upstream` uses upstream's target exits, percentage profit locks and
Donchian/ATR trailing. The previous Catfolio breakeven, peak-net-profit, partial-profit
and bounded profit-review controls remain with `STRATEGY_ENGINE=catfolio`; they are not
silently layered onto Argon's strategy rewrite. The independent protective watch serves
both engines. Trainer evidence is versioned, old overrides are retired on a strategy
change, and the trainer stays benched in upstream mode. The previous trainer remains available with `STRATEGY_ENGINE=catfolio`.

Without an explicit provider, a Gemini key selects Gemini; otherwise the prior LM Studio
default remains. Without an explicit strategy engine, Gemini selects upstream strategies
and the previous providers keep Catfolio strategies. Set both switches explicitly when
comparing providers on the same strategy.

## Future upstream updates

The local `upstream` remote points to the original repository. Fetch new changes, compare
them against the pinned revision above, and integrate on a branch. Keep upstream strategy
files and the Catfolio adapters separate. Avoid replacing `main` or using a force-sync
operation: the current product and its historical work remain valuable.

The pre-migration tracked diff and untracked files were saved locally under
`.git/codex-backups/upstream-argon-2026-10-21/`; ignored credentials and databases were
not copied into this source checkpoint.

## Validation

On 21 October 2026: 544 tests passed across 38 files; TypeScript, lint, engine build,
dashboard build and Compose validation passed. Both engine and dashboard Docker images
built successfully. The engine image passed an isolated Node 22.23.3 provider/configuration
smoke check with networking disabled. The dashboard and engine details dialog were checked
in a browser using an in-memory simulated run. No paid Gemini request, exchange order,
deployment restart or change to the owner's `.env` was performed.
