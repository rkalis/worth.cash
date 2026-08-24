import { getChainConfig } from 'lib/chains';
import { getEnabledChainIds } from 'lib/chains/enabled';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import { syncCursorKey } from 'lib/db/keys';
import { loadSettings } from 'lib/db/settings';
import { recordCurrentSnapshot } from 'lib/history/snapshot';
import { syncFloorPrices } from 'lib/nfts/floor-prices';
import { syncNftMetadata } from 'lib/nfts/metadata';
import { refreshAssetMap, resolveCoinGeckoIdsForSymbols } from 'lib/prices/assets';
import { primeContractCoinIdMap } from 'lib/prices/coin-ids';
import { fetchCoinGeckoIdPrices, fetchOnChainPrices } from 'lib/prices/current';
import { hasChainActivity } from 'lib/sync/activity';
import { syncTokenBalances } from 'lib/sync/balances';
import { syncTransferEvents } from 'lib/sync/events';
import { syncAllExchangeAccounts } from 'lib/sync/exchanges';
import { syncTokenMetadata } from 'lib/sync/metadata';
import { syncNftBalances } from 'lib/sync/nfts';
import { type SyncPhase, useSyncProgress } from 'lib/sync/progress';
import { deduplicateArray } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import type { Address } from 'viem';

export interface SyncOptions {
  // Restricts the run to specific wallets. Defaults to every enabled wallet.
  owners?: Address[];
  // Restricts the run to specific chains. Defaults to whatever the settings enable.
  chainIds?: number[];
  includeExchanges?: boolean;
  // Fetching exchange transaction history is only needed to reconstruct past points in the chart.
  includeExchangeLedger?: boolean;
}

// Runs a full sync across every tracked wallet and chain.
//
// Chains are processed concurrently up to a configured limit, and a failure on one chain never stops the
// others: a wallet with holdings on forty chains should not lose all of them because one explorer is down.
export const runSync = async (options: SyncOptions = {}): Promise<void> => {
  const settings = await loadSettings();

  const wallets = await db.wallets.where('enabled').equals(1).toArray();
  const owners = options.owners ?? (wallets.map((wallet) => wallet.address) as Address[]);

  const chainIds = options.chainIds ?? getEnabledChainIds(settings.sync.enabledChainIds, settings.sync.includeTestnets);

  // A portfolio does not have to contain a wallet. Someone tracking only Bitcoin through a manual balance,
  // or only an exchange account, still needs a sync to fetch prices and record a point in their history,
  // so the chain work is skipped rather than the whole run being abandoned.
  const tasks = owners.flatMap((owner) => chainIds.map((chainId) => ({ chainId, owner })));

  const progress = useSyncProgress.getState();
  progress.beginRun(tasks);

  try {
    if (tasks.length > 0) {
      // Fetched before any chain work starts. It is what every token's identity depends on, and fetching it
      // later would put it behind a queue of price lookups on a rate limit it cannot win.
      progress.setCoinIdMapAvailable(await primeContractCoinIdMap().catch(() => false));

      // Market data for the top few hundred coins, which carries the only icons available for assets held on
      // an exchange, where there is no contract to look up. Refreshed even when no exchange is configured,
      // since the same icons stand in for on-chain tokens the whois dataset has never seen.
      await refreshAssetMap().catch(() => undefined);

      await mapAsyncBounded(tasks, settings.sync.chainConcurrency, (task) =>
        syncChainForOwner(task.chainId, task.owner, settings.sync.skipInactiveChains),
      );

      await syncPricesForHoldings(chainIds);
    }

    if (options.includeExchanges !== false) {
      await syncExchanges(options.includeExchangeLedger === true);
    }

    // Manual holdings are priced by coin id like anything else, but nothing discovers them: they exist only
    // because the user typed them in, so their ids have to be gathered explicitly.
    await syncManualBalancePrices().catch(() => undefined);

    // Where the portfolio ended up, recorded as a point in its history.
    //
    // This is the only thing that writes history automatically, and it is deliberately tied to a sync the
    // user asked for rather than to a clock: a point means "this is what it was worth when I looked",
    // which is a fact the user created. Anything else that calls runSync in future is opting into writing
    // history, and should think about whether it wants to.
    await recordCurrentSnapshot().catch(() => undefined);
  } finally {
    useSyncProgress.getState().finishRun();
  }
};

// The full pipeline for one wallet on one chain. Each step depends on the one before it: events determine
// which tokens to check balances for, balances determine which need metadata, and so on.
const syncChainForOwner = async (chainId: number, owner: Address, skipInactiveChains: boolean): Promise<void> => {
  const progress = useSyncProgress.getState();
  const failures: string[] = [];

  // Each phase is isolated rather than sharing one try block.
  //
  // The phases are not equally dependent on the chain being reachable, and treating them as one unit means a
  // chain whose RPC or explorer is down loses work it could still have done. Enriching token metadata, in
  // particular, is a plain HTTP fetch against a static dataset and needs no chain access at all: it operates
  // on balances already in the database. Aborting it because reading logs failed is what left every token on
  // an unreachable chain without a logo.
  const runPhase = async <T>(phase: SyncPhase, run: () => Promise<T>): Promise<T | undefined> => {
    progress.updateTask(chainId, owner, { phase });

    try {
      return await run();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  progress.updateTask(chainId, owner, { status: 'syncing' });

  // Checked before anything expensive, and only for chains we have never successfully synced. A chain with
  // an existing cursor has already produced data, so re-checking could only ever hide it.
  if (skipInactiveChains && !(await hasStoredHistory(chainId, owner))) {
    progress.updateTask(chainId, owner, { phase: 'activity' });

    if (!(await hasChainActivity(chainId, owner))) {
      progress.updateTask(chainId, owner, { status: 'skipped', phase: 'done' });
      return;
    }
  }

  const eventResult = await runPhase('events', () => syncTransferEvents(chainId, owner));
  if (eventResult) progress.updateTask(chainId, owner, { newEventCount: eventResult.newEventCount });

  const balanceResult = await runPhase('balances', () => syncTokenBalances(chainId, owner));
  if (balanceResult) progress.updateTask(chainId, owner, { heldTokenCount: balanceResult.heldTokenCount });

  await runPhase('metadata', () => syncTokenMetadata(chainId, owner));

  const nftResult = await runPhase('nfts', () => syncNftBalances(chainId, owner));
  if (nftResult) progress.updateTask(chainId, owner, { heldNftCount: nftResult.heldItemCount });

  if (nftResult && nftResult.heldItemCount > 0) {
    await runPhase('floor-prices', async () => {
      // Only the collections actually held. This used to price every collection ever seen on the chain,
      // which for a wallet that has been airdropped junk for years means paying for hundreds of them on
      // every refresh to value NFTs it no longer owns.
      const heldItems = await db.nftItems.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();
      const heldCollections = deduplicateArray(heldItems.map((item) => item.collection)) as Address[];

      await syncFloorPrices(chainId, heldCollections);
      await syncNftMetadata(chainId, owner);
    });
  }

  progress.updateTask(chainId, owner, {
    status: failures.length > 0 ? 'error' : 'done',
    phase: 'done',
    // The first failure is the one worth showing: later phases usually fail for the same underlying reason.
    error: failures[0],
  });
};

// Whether this chain has ever produced anything for this address. Used to make the activity check strictly
// an optimisation for first syncs: once a chain has a cursor, it is never skipped again.
const hasStoredHistory = async (chainId: number, owner: Address): Promise<boolean> => {
  const cursor = await db.syncCursors.get(syncCursorKey(chainId, owner));
  return Boolean(cursor);
};

// Prices every token we actually hold, in one pass across all chains, after balances are known. Doing it
// here rather than per chain means one batched request per chain instead of one per wallet per chain.
const syncPricesForHoldings = async (chainIds: number[]): Promise<void> => {
  const [balances, tokens] = await Promise.all([db.balances.toArray(), db.tokens.toArray()]);
  const tokensById = new Map(tokens.map((token) => [token.id, token]));

  // Anything CoinGecko has listed is priced by coin id: one batched request covers every chain at once, and
  // the result is the asset's market price rather than a single pool's quote.
  const listedCoingeckoIds = deduplicateArray(
    balances
      .map((balance) => tokensById.get(`${balance.chainId}:${balance.token}`)?.coingeckoId)
      .filter((coingeckoId) => Boolean(coingeckoId)),
  ) as string[];

  const nativeCoingeckoIds = deduplicateArray(
    chainIds.map((chainId) => getChainConfig(chainId).getNativeTokenCoingeckoId()).filter((id) => Boolean(id)),
  ) as string[];

  await fetchCoinGeckoIdPrices([...listedCoingeckoIds, ...nativeCoingeckoIds]).catch(() => undefined);

  // Unlisted tokens have no coin id, so the only price available is their own on-chain pool.
  await Promise.all(
    chainIds.map(async (chainId) => {
      const unlistedTokens = deduplicateArray(
        balances
          .filter((balance) => balance.chainId === chainId)
          .filter((balance) => balance.token !== NATIVE_TOKEN_ADDRESS.toLowerCase())
          .filter((balance) => !tokensById.get(`${balance.chainId}:${balance.token}`)?.coingeckoId)
          .map((balance) => balance.token),
      ) as Address[];

      if (unlistedTokens.length === 0) return;
      await fetchOnChainPrices(chainId, unlistedTokens).catch(() => undefined);
    }),
  );
};

const syncManualBalancePrices = async (): Promise<void> => {
  const balances = await db.manualBalances.where('enabled').equals(1).toArray();
  const coingeckoIds = deduplicateArray(
    balances.map((balance) => balance.coingeckoId).filter((coingeckoId) => Boolean(coingeckoId)),
  ) as string[];

  if (coingeckoIds.length === 0) return;

  await fetchCoinGeckoIdPrices(coingeckoIds);
};

const syncExchanges = async (includeLedger: boolean): Promise<void> => {
  const progress = useSyncProgress.getState();
  const accounts = await db.exchangeAccounts.where('enabled').equals(1).toArray();

  if (accounts.length === 0) {
    progress.setExchangeStatus('done');
    return;
  }

  try {
    progress.setExchangeStatus('syncing');
    await syncAllExchangeAccounts({ includeLedger });

    // Exchange assets are priced by symbol, which has to be resolved to a CoinGecko id first.
    const exchangeBalances = await db.exchangeBalances.toArray();
    const symbols = deduplicateArray(exchangeBalances.map((balance) => balance.asset));
    const idsBySymbol = await resolveCoinGeckoIdsForSymbols(symbols);

    await fetchCoinGeckoIdPrices([...idsBySymbol.values()]);

    progress.setExchangeStatus('done');
  } catch (error) {
    progress.setExchangeStatus('error', error instanceof Error ? error.message : String(error));
  }
};
