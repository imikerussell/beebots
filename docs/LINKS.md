# Documentation links (every URL checked 2026-09-24)

## Jev / TypeSafe AI
- https://docs.typesafe.ai/llms.txt: machine-readable index of every docs page. **Start here.**
- https://docs.typesafe.ai/introduction/quickstart: Playground, curl, full request/response, Python example.
- https://docs.typesafe.ai/api: `POST https://api.typesafe.ai/v1/systemone`. Full schema: `state`, `model`, `questions` (`choice` ≤255 options, `score` 2-10 levels, `noul`); response `answers` + `usage`; errors 401/422/429/529.
- https://docs.typesafe.ai/models: **pricing + rate limits** (`jev-1.13.0`, $0.042/M input, output free, 1,200 req/min, 250k tok/s, 64k context / 32k state+question). *(/pricing, /rate-limits and /errors are 404; this page is the real one.)*
- https://docs.typesafe.ai/sdk/javascript: TypeScript SDK (`@typesafe-ai/sdk` 0.6.0, Node 20+). Source: https://github.com/typesafe-ai/typesafe-sdk-js
- https://docs.typesafe.ai/sdk/python: Python SDK (`typesafe-sdk` 0.7.1).
- https://console.typesafe.ai: API keys (`/keys`) and Playground (`/playground`).
- https://github.com/typesafe-ai/skills: Claude Code skill. Install with `claude plugin marketplace add typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`. **Install this before building.**
- https://vercel.com/ai-gateway/models/jev: Jev via Vercel AI Gateway (`typesafe-ai/jev`, same price). A fallback route if the direct API has trouble.

## OKX Agent Trade Kit (MIT)
- https://github.com/okx/agent-trade-kit: the repo. **Default branch is `github-main`**; `master` links redirect to an old backup branch.
- https://www.okx.com/docs-v5/agent_en/: OKX's official guide to the kit. (It still links the OLD unscoped npm names; use the `@okx_ai/` ones below.)
- https://github.com/okx/agent-trade-kit/blob/github-main/docs/configuration.md: `~/.okx/config.toml`, profiles, `site = "eea"`, demo profiles, proxy.
- https://github.com/okx/agent-trade-kit/blob/github-main/docs/site-compatibility.md: per-site smoke tests. EEA demo works; `/account/leverage-info` 404s on EEA.
- https://github.com/okx/agent-trade-kit/blob/github-main/docs/cli-reference.md: `okx` CLI reference (subcommands use spaces; MCP tool names use underscores).
- Modules: [market](https://github.com/okx/agent-trade-kit/blob/github-main/docs/modules/market.md) (no key) · [futures](https://github.com/okx/agent-trade-kit/blob/github-main/docs/modules/futures.md) (X-Perps are FUTURES) · [account](https://github.com/okx/agent-trade-kit/blob/github-main/docs/modules/account.md) · [news](https://github.com/okx/agent-trade-kit/blob/github-main/docs/modules/news.md)
- https://github.com/okx/agent-trade-kit/tree/github-main/skills: agent skills (okx-cex-market, -trade, -portfolio...).
- https://github.com/okx/agent-skills: separate OKX skills repo.
- npm: `@okx_ai/okx-trade-cli` (binary `okx`) and `@okx_ai/okx-trade-mcp`, both 1.4.8 (2026-09-23). **No importable core library**, so the engine shells out to the CLI for signed calls and runs public market data on a vendored copy of the kit's REST client (`src/okx/kit/`).md §3.1.

## OKX API v5, EEA edition
- https://my.okx.com/docs-v5/en/: EEA docs. REST `https://eea.okx.com`; WS `wss://wseea.okx.com:8443/ws/v5/{public,private,business}`; demo WS `wss://wseeapap.okx.com:8443/ws/v5/...`.
- API key security (IP binding; unbound trade keys expire after 14 days of inactivity): https://my.okx.com/docs-v5/en/#overview-api-key-creation-api-key-security
- Demo trading (`x-simulated-trading: 1`): https://my.okx.com/docs-v5/en/#overview-demo-trading-services
- Rate limits: https://my.okx.com/docs-v5/en/#overview-rate-limits
- Instruments: https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-instruments
- Fee rates: https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-fee-rates
- Error codes: https://my.okx.com/docs-v5/en/#error-code
- Create sub-account: https://my.okx.com/docs-v5/en/#sub-account-rest-api-create-sub-account
- List sub-accounts: https://my.okx.com/docs-v5/en/#sub-account-rest-api-get-sub-account-list
- Master ↔ sub transfers: https://my.okx.com/docs-v5/en/#sub-account-rest-api-master-accounts-manage-the-transfers-between-sub-accounts
- Self-trade prevention: `acctStpMode` (account config) and per-order `stpMode` (place-order section); default `cancel_maker`.
- Fee schedule (EU): https://www.okx.com/en-eu/fees

## OKX X-Perps (the product)
- https://www.okx.com/en-eu/x-perps: product page.
- https://www.okx.com/en-eu/help/how-to-trade-x-perps: crypto, stocks and commodities, up to 10x, cash-settled 60 months after issue.
- https://www.okx.com/en-us/help/okx-x-perps-eea-what-are-expiry-perps: explainer (continuous funding, real-time margining).
- https://www.okx.com/en-eu/learn/how-to-start-trading-x-perps-on-okx: states **demo trading for X-Perps is available in the EEA**.

## Hostinger
- https://www.hostinger.com/vps-hosting: plans (KVM 2: 2 vCPU / 8 GB / 100 GB NVMe / 8 TB).
- https://www.hostinger.com/support/5634532-how-to-generate-ssh-keys-and-add-them-to-hostinger-dashboard/: add your SSH key in hPanel.
- https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/: Ubuntu 24.04 + Docker template.
- https://www.hostinger.com/support/9615197-how-to-use-the-coolify-vps-template-at-hostinger/: Coolify template (optional).
- https://www.hostinger.com/support/4805502-how-to-set-up-a-firewall-at-vps/: hPanel firewall (drop-all default once on; add 22/80/443).
- https://docs.hostinger.com/api-reference/overview: Hostinger API.

## Strategy research
See the individual files in `strategies/`. Every paper, backtest and code source is cited there with a link.

## Reference implementation worth reading (not a dependency)
- `jev-trader`: one Jev decision per block, SSE event feed, and a dry run with simulated fills on a real order book. Borrow its **event shape and dashboard idea**, not its venue (it runs on Monad/Kuru).
