# Worth.cash

What your crypto is worth, wherever it is. A self-hosted portfolio tracker: It watches EVM wallet addresses across ~90 chains, pulls balances
from Coinbase and Kraken, and keeps everything in your browser's IndexedDB. There is no server-side
database, no account, and nothing is uploaded anywhere except to the APIs whose keys you configure.

## What it does

- **Token logos and curated spam flags** from the revoke.cash whois dataset, which is the only source in the
  pipeline that has an image for a token: an ERC20 contract exposes a name, a symbol and decimals, but no icon.
- **Tokens**, aggregated across every place you hold them by CoinGecko coin id. USDC on Base and USDC on
  Arbitrum are one row with a per-location breakdown; a token that merely calls itself USDC is not.
- **Exchange balances** are part of that same list rather than a table of their own: an exchange account is
  just another location an asset sits in, alongside the chains. ETH on Base, ETH on Ethereum and ETH on
  Kraken are one row, expandable into the three places holding it. The summary still reports on-chain and
  exchange value separately, since a row can now span both.
- **Cash held on an exchange** is valued too, from the same reference rates the display currency uses,
  instead of showing up as an unpriced row and being filtered away with the spam.
- **Manual balances**, on their own page, for anything the app cannot discover: Bitcoin, Solana, a hardware
  wallet, a chain that is not supported. You give it a symbol, a location and a CoinGecko coin id to price it
  by, then record the buys and sells with the dates they happened. The balance is derived from that ledger
  rather than typed in, so a past snapshot values what you actually held at the time instead of assuming
  today's quantity. Snapshots taken before you recorded a balance can be brought up to date from the History
  page, which folds the ledger into them at each moment's own price without adding points or touching the
  on-chain figures those snapshots already hold. Because the price source is a coin id, a manual BTC holding shares a row with the BTC on
  your exchange, listed as another location beside it.
- **NFTs**, grouped by collection, with artwork and floor prices from CoinGecko. The portfolio page carries a condensed collection table; the NFTs page has the full view with
  per-item artwork.
- **A value chart you control.** Nothing is recorded on a schedule: a snapshot is written every time you
  sync, and you can add one for any past moment by picking a date and time on the History page, which
  reconstructs what was held then from the transfer history already stored locally, reporting each step as it
  goes. Snapshots you did not mean to take can be deleted. The dashboard shows the total, the change over
  1W/2W/1M/3M/1Y, and the chart in one place, with the chart windowed to whichever range you pick.

  Because snapshots land whenever you sync rather than on a schedule, a change is measured against the
  nearest snapshot on or before that point, which can be older than the period names. Each figure says
  which moment it actually used.
- **A display currency**, US dollars or euro. Prices are always fetched and stored in dollars; another
  currency is converted from that at the moment a figure becomes text.
- **Spam filtering** in four layers: below a minimum quantity, no price, below a dust threshold in your
  currency, and name/symbol heuristics. Nothing
  is ever deleted; filtered positions stay one click away and can be permanently shown or hidden per token.
  Both the no-price rule and the dust threshold apply to NFT collections as well, valued at their floor.

## Getting started

```bash
corepack yarn install
```

```bash
corepack yarn dev
```

Then open http://localhost:3000, go to **Settings**, add a wallet address, and press **Sync now** on the
portfolio page.

## API keys

Every key is optional and is stored in your browser, not on the server. The app uses whichever data sources
your keys allow and degrades rather than failing when one is missing.

| Key | What it unlocks | Without it |
| --- | --- | --- |
| Etherscan (V2) | Log history on every Etherscan-family explorer. One key covers all of them. | Explorer requests drop to 1 per 5 seconds, too slow to sync a full history |
| CoinGecko | All prices, including NFT floors. Plan is detected automatically. | Much lower rate limits, 365 days of history at most, and no historical NFT floors |
| Blockscout | The ~21 chains routed through Blockscout's hosted API, which now answers keyless requests with HTTP 402 | Those chains fail to sync and say so |
| Alchemy / dRPC (see below) | A reliable RPC per chain | Public endpoints, many of which refuse browser requests |
| HyperSync (Envio) | Fast log history on the chains configured for it | Those chains fall back to their public RPC |
| Alchemy / dRPC | Better RPC endpoints on the chains whose config prefers them | Public RPCs, with their rate limits |

For **exchange accounts**, use read-only keys. Coinbase expects a CDP key (either an EC private key in PEM
form or a base64 Ed25519 key) plus its full key name; Kraken expects an API key and its base64 private key.

## How balances are discovered

Etherscan's "all token holdings for an address" endpoint is a paid feature, so this app does not use it.
Instead it works the way [revoke.cash](https://revoke.cash) does:

1. Fetch every ERC-20, ERC-721 and ERC-1155 `Transfer` log where the address is the sender or the recipient,
   from whichever source each chain is configured for (RPC node, HyperSync, Etherscan, Blockscout or
   Routescan), and store them locally.
2. Treat every token that appears as a candidate, and read its **actual** balance with a multicall. Balances
   are read rather than summed from events, because rebasing and fee-on-transfer tokens would otherwise
   produce numbers that look plausible and are wrong.
3. Price what is left, and aggregate across chains.

Aggregation identity is CoinGecko's **coin id**, never the token symbol. This is a security property, not a
tidiness one: deploying a token called USDC costs nothing, so grouping by symbol lets an attacker's airdrop
join the row for real USDC and be counted at real USDC's price. A coin id comes from CoinGecko's own mapping
of coin to deployed contract and cannot be claimed by an impostor. Anything CoinGecko has never listed gets
an identity unique to its own contract, so it can never merge with anything, and nothing ever inherits a
price from a sibling. It also separates native USDC from bridged USDC.e, which really are different assets.

The contract-to-coin-id map is one request (`/coins/list?include_platform=true`, around 26,000 address
mappings) fetched before anything else in a sync, cached for a day. If it cannot be fetched, tokens show per
chain rather than combined, and the sync bar says so.

An exchange balance joins that same row through the same coin id, but it reaches it by a weaker route, and
the difference is worth knowing. An on-chain token's coin id comes from CoinGecko's own contract mapping and
cannot be forged. An exchange reports a ticker and an amount, nothing more, so its coin id is resolved
through a market-cap-ordered list of the top several hundred coins: the ticker maps to the asset an exchange
would plausibly be listing rather than to an impostor. That is right for the assets exchanges actually list,
but it is a best-effort match rather than a proof, so a merged row always shows which locations it is made
of. Cash tickers are intercepted before that lookup, so a euro balance is valued as a euro and can never
merge with a euro stablecoin.

That market data is also where the icons for exchange-held assets come from. There is no contract to look up
in the whois dataset for BTC or SOL, and the same request that prices them carries their artwork, so it is
stored alongside the ticker map and doubles as a fallback icon for on-chain tokens whois has never seen.

NFT floors come from CoinGecko: a single request keyed by contract address, answered as a USD figure
directly rather than one denominated in whatever token a marketplace quotes, using the key token pricing
already needs. Its limit is breadth, at roughly two thousand collections, so the long tail of a typical
wallet has no floor and is counted at nothing. A "not indexed" answer is cached for a week,
while a rate-limited or failed lookup is not cached at all, so a transient error never masquerades as a
missing collection.

Because the logs are stored, a sync is incremental: only the blocks since the last one are fetched. The
first sync is the expensive one, and syncing every supported chain at once is deliberately the default. Use
**Majors only** in settings if you would rather not wait.

Chains an address has never touched are skipped before any of that happens. revoke.cash does the same thing
with a nonce check, but it can go further than we can: granting a token approval requires sending a
transaction, so a nonce of zero proves there is nothing to find. A portfolio has no such guarantee, since an
address can hold real value having never sent a transaction, which is what a wallet funded by an exchange
withdrawal looks like. So the native balance is checked alongside the nonce, and a chain is skipped only when
both are zero *and* it has never synced successfully before. Skipped chains are labelled as such rather than
reported as empty. The residual gap is an address holding only ERC-20s or NFTs with no native balance and no
transactions, which is why the check can be turned off in settings.

## Display currency

Every price is fetched and stored in US dollars, and that never changes. The display currency only decides
what a stored dollar figure is converted to on its way to the screen, in one place: the formatting helpers
in `lib/format`. Totals, percentage shares and the dust thresholds are all computed in dollars upstream, so
a converted number can never reach a threshold comparison and quietly filter a different set of positions
than the one you configured.

Rates are the European Central Bank's daily reference rates, via [Frankfurter](https://frankfurter.dev). It
was chosen for one practical reason: it is the only free rate source a browser can call directly, needing no
key and sending `Access-Control-Allow-Origin: *`. The ECB's own feed sends no CORS headers at all and would
need a route handler in front of it. Rates are cached for twelve hours, and a failed refresh keeps the last
ones rather than reverting every figure on the page to dollars. If no rate has ever been fetched, the app
says so in settings and shows dollars instead of rendering `€NaN`.

## Why chains fail to sync

Two causes account for nearly all of it, and both are consequences of reading chains from the browser rather
than from a server:

- **Blockscout's hosted API now requires a key.** Requests to `api.blockscout.com` without one come back as
  HTTP 402 (`Proceed with API key or make a X402 payment to continue`), which affects the ~21 chains routed
  through it. The sync reports this as "needs a Blockscout API key" rather than as a generic failure,
  because it is the one cause you can fix.
- **Explorer CORS policy is inconsistent.** Etherscan sends `Access-Control-Allow-Origin: *`, and so do some
  Blockscout instances, but others send only their own origin and some send nothing at all, which the
  browser refuses. Rather than guess per chain, the app tries each host directly and falls back to its own
  `/api/explorer` proxy for the ones that block it, remembering the outcome per host. This is handled
  automatically and needs no configuration.

Anything left over is usually a genuinely dead explorer endpoint, and the error reports the HTTP status it
returned.

A chain that fails is not all-or-nothing. Each step of a chain's sync runs independently, so a chain whose
logs cannot be read still refreshes everything that does not depend on reading them: token metadata, logos
and prices all update from balances already stored. The failure is still reported; it just no longer discards
unrelated work.

Chains read over plain RPC have a related problem. The public endpoint lists are noisy: they contain
unresolved templates (`https://mainnet.infura.io/v3/${INFURA_API_KEY}`), WebSocket URLs alongside HTTP ones,
and hosts that are dead or refuse browser requests. All three are filtered out, and the client is given the
chain's whole remaining list so it can fail over rather than giving up on the first entry. Even so, some
chains have no browser-usable public endpoint at all: **Ethereum is one of them**, so set an Alchemy or dRPC
key, or a custom RPC for that chain, in settings.

## Known limitations

- **Snapshots added for a past date are reconstructed from transfer events**, so they are exact for ordinary
  ERC-20s and approximate for rebasing or fee-on-transfer tokens. A snapshot recorded by a sync is not
  reconstructed at all: balances have just been read from the chain, so it is exactly the figure the
  dashboard was showing.
- **Historical native balances need an archive node.** ETH and friends move without emitting any event, so
  past balances are read from chain state instead. Chains whose RPC cannot serve that are reported when a
  snapshot is added; setting a custom RPC for them in settings fixes it.
- **Historical NFT floors need a paid CoinGecko plan.** Its `/nfts/{id}/market_chart` endpoint is PRO-only,
  so on a free or demo key a reconstructed point values NFTs at today's floor with historically correct
  quantities. Adding a snapshot reports how many collections that applied to.
- **Free and demo CoinGecko plans cap history at 365 days.** A moment older than that cannot be priced, so
  adding a snapshot for it is refused with the earliest date that would work, rather than writing a point
  worth nothing that looks like a real crash.
- **Past values are converted at today's rate.** The chart in euro is your portfolio's dollar history
  expressed in today's euro, not what it was worth in euro at the time. Snapshots store dollars, and mixing a
  historical FX rate into them would make two charts disagree about the same moment.
- **Exchange credentials are stored in plain text** in IndexedDB. That is a deliberate trade for a personal,
  self-hosted app where balances refresh unattended; anyone with access to your browser profile can read
  them. Use read-only keys.

## Architecture

Single Next.js app, no monorepo.

- `app/` - App Router pages, plus the few route handlers that exist only because a browser cannot do the job
  itself: HMAC/JWT-signed exchange calls, CORS-blocked APIs, the native HyperSync client, and NFT
  metadata/artwork fetching from arbitrary hosts.
- `lib/chains/`, `lib/events/` - chain metadata and log retrieval, ported and trimmed from
  `@revoke.cash/core`.
- `lib/db/` - the Dexie schema, and the only persistence layer.
- `lib/sync/` - the pipeline that turns logs into balances.
- `lib/prices/`, `lib/nfts/`, `lib/exchanges/`, `lib/portfolio/`, `lib/history/` - feature modules.

## Commands

```bash
corepack yarn typecheck && corepack yarn lint && corepack yarn test
```
