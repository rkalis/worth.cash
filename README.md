# Worth.cash

What your crypto is worth, wherever it is. A self-hosted portfolio tracker: it watches EVM wallet addresses across ~90 chains, pulls balances from Coinbase and Kraken, and keeps everything in your browser's IndexedDB. It was built to fit my own needs, not necessarily anyone else's: the features, defaults and trade-offs are the ones I wanted. There is no server-side database and no account; the only network traffic is to the data sources the app reads: the APIs you configure keys for, plus a few keyless ones (ECB exchange rates, the revoke.cash token dataset, public RPCs).

> [!NOTE]
> **This app is 100% vibe coded.** Every line was written by an AI coding agent. It has tests, but no human has read it. Judge it accordingly.

> [!IMPORTANT]
> **It requires your own API keys.** Etherscan, Blockscout, Alchemy and Envio HyperSync keys are needed for syncing to function; dRPC and CoinGecko keys are optional on top. Keys are entered in the settings UI and stored in your browser, nowhere else.

## Getting started

```bash
corepack yarn install
```

```bash
corepack yarn dev
```

Then open http://localhost:3000, add your API keys and a wallet address in **Settings**, and press **Sync now**.

## API keys

| Key | Needed | What it does |
| --- | --- | --- |
| Etherscan (V2) | Required | Log history on every Etherscan-family explorer; one key covers all of them. Keyless requests are limited to 1 per 5 seconds, far too slow to sync a history. |
| Blockscout | Required | The ~21 chains routed through Blockscout's hosted API, which refuses keyless requests with HTTP 402. |
| Alchemy | Required | Reliable RPCs. Some chains, Ethereum included, have no public RPC a browser can use. |
| HyperSync (Envio) | Required | Fast log history on the chains configured for it. Keyless requests are rate limited too low to sync a full history. |
| dRPC | Optional | Preferred RPC on some chains; without it those chains use their public endpoints. |
| CoinGecko | Optional | Higher price rate limits, history beyond 365 days, and historical NFT floors on paid plans. The plan is detected automatically. |

For **exchange accounts**, use read-only keys. Coinbase expects a CDP key (an EC private key in PEM form or a base64 Ed25519 key) plus its full key name; Kraken expects an API key and its base64 private key.

## What it does

- **One row per asset, wherever it sits.** Tokens are aggregated across chains and exchange accounts by CoinGecko coin id: USDC on Base, USDC on Arbitrum and USDC on Kraken are one row, expandable into the locations holding it.
- **Aggregation by coin id is a security property.** Deploying a token called USDC costs nothing, so grouping by symbol would let an impostor join the real row and be counted at the real price. A coin id comes from CoinGecko's own contract mapping and cannot be claimed; a token CoinGecko has never listed can never merge with anything. An exchange reports only a ticker, so its coin id is a best-effort match against the top coins by market cap rather than a proof, and a merged row always shows which locations it is made of.
- **Manual balances** for anything the app cannot discover: Bitcoin, Solana, a hardware wallet. You record the buys and sells with their dates, so a past snapshot values what you actually held at that moment.
- **NFTs by collection**, with artwork and floor prices from CoinGecko, which indexes only about two thousand collections; long-tail collections have no floor and are counted at nothing.
- **A value chart you control.** A snapshot is written on every sync; one can be added for any past moment (reconstructed from the locally stored transfer logs), backfilled weekly going back to a date you pick, or deleted. Clicking a point on the chart pins that snapshot, and the portfolio and graphs show that moment through today's settings.
- **Spam filtering** in four layers: minimum quantity, no price, a dust threshold in dollars (regardless of the display currency), and name heuristics. Nothing is deleted; filtered positions stay one click away.
- **Export and import.** All local data as one compressed file, selectable by slice: raw data, settings, API keys, exchange accounts.
- **USD or EUR display.** Prices are fetched and stored in dollars and converted only at display time, using ECB reference rates.

## How balances are discovered

Etherscan's "all token holdings" endpoint is paid, so the app works the way [revoke.cash](https://revoke.cash) does: fetch every ERC-20, ERC-721 and ERC-1155 `Transfer` log where the address is sender or recipient, store the logs locally, treat every token that appears as a candidate, then read the actual balances with a multicall. Balances are read rather than summed from events because rebasing and fee-on-transfer tokens would otherwise produce plausible, wrong numbers.

Syncs are incremental, so the first one is the expensive one. Syncing every supported chain at once is deliberately the default; settings has a **Majors only** switch if you would rather not wait. Chains showing no activity (zero nonce and zero native balance) are skipped; that check can be turned off in settings, since an address holding only tokens can trip it.

## Known limitations

- **Past-date snapshots are reconstructed from transfer events**: exact for ordinary ERC-20s, approximate for rebasing or fee-on-transfer tokens. Snapshots recorded by a sync use balances read from the chain.
- **Historical native balances need an archive node.** Chains whose RPC cannot serve past state are reported when a snapshot is added; a custom RPC in settings fixes it.
- **Historical NFT floors need a paid CoinGecko plan.** Without one, reconstructed points value NFTs at today's floor with historically correct quantities.
- **Free and demo CoinGecko plans cap price history at 365 days.** Adding a snapshot older than that is refused with the earliest date that would work, rather than writing a point worth nothing.
- **Past values are converted at today's rate.** The chart in euro is your dollar history expressed in today's euro, not what it was worth in euro at the time.
- **Exchange credentials are stored in plain text** in IndexedDB, a deliberate trade for a personal self-hosted app. Use read-only keys.

## Architecture

Single Next.js app.

- `app/` - App Router pages, plus the few route handlers a browser cannot replace: signed exchange calls, CORS-blocked APIs, the native HyperSync client, NFT artwork fetching.
- `lib/chains/`, `lib/events/` - chain metadata and log retrieval, ported and trimmed from `@revoke.cash/core`.
- `lib/db/` - the Dexie (IndexedDB) schema, the only persistence layer.
- `lib/sync/` - the pipeline that turns logs into balances.
- `lib/prices/`, `lib/nfts/`, `lib/exchanges/`, `lib/portfolio/`, `lib/history/` - feature modules.

## Commands

```bash
corepack yarn typecheck && corepack yarn lint && corepack yarn test
```
