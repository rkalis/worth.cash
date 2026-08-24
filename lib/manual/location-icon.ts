import type { ExchangeKind } from 'lib/db/schema';
import type { StoredAssetMap } from 'lib/prices/assets';

// How to draw a manual holding's location.
//
// Exactly one of these is set, or none of them, in which case the caller falls back to its placeholder.
export interface LocationIcon {
  chainId?: number;
  exchange?: ExchangeKind;
  logoUrl?: string;
}

export interface LocationIconSources {
  // Lowercase chain name to chain id, for the chains the app supports natively.
  chainIdsByName: Map<string, number>;
  // Lowercase account label to which exchange it is, so a location named after one gets its brand mark.
  exchangesByLabel: Map<string, ExchangeKind>;
  assetMap?: StoredAssetMap;
}

const NO_ICON: LocationIcon = {};

// Works out what a location typed by hand is a picture of.
//
// A manual balance's location is free text, because the places that need recording by hand are the ones the
// app knows nothing about. That does not mean nothing is known about the words: "Bitcoin Cash" is the name
// of a coin the market data already carries an icon for, and that name is the link between a place with no
// chain id and a picture of it.
//
// Tried in order of how specific the match is:
//   1. A supported chain, which has a local logo and should look the same as it does everywhere else.
//   2. One of the user's exchange accounts, which has a brand mark.
//   3. A coin by name, which is what catches Bitcoin, Solana, Litecoin and every other chain named after
//      its native asset.
//   4. A coin by ticker, for someone who typed "BTC" rather than "Bitcoin".
//
// Anything else, a wallet brand or "cold storage", matches nothing and keeps its placeholder.
export const resolveLocationIcon = (location: string, sources: LocationIconSources): LocationIcon => {
  const name = location.trim().toLowerCase();
  if (!name) return NO_ICON;

  const chainId = sources.chainIdsByName.get(name);
  if (chainId !== undefined) return { chainId };

  const exchange = sources.exchangesByLabel.get(name);
  if (exchange) return { exchange };

  const coingeckoId = sources.assetMap?.names?.[name] ?? sources.assetMap?.symbols?.[name];
  const logoUrl = coingeckoId ? sources.assetMap?.logos?.[coingeckoId] : undefined;

  return logoUrl ? { logoUrl } : NO_ICON;
};
