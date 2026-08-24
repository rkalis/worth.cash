import type { LocationIconSources } from 'lib/manual/location-icon';
import { resolveLocationIcon } from 'lib/manual/location-icon';
import { describe, expect, it } from 'vitest';

const sources = (overrides: Partial<LocationIconSources> = {}): LocationIconSources => ({
  chainIdsByName: new Map([
    ['ethereum', 1],
    ['base', 8453],
  ]),
  exchangesByLabel: new Map([['kraken', 'kraken']]),
  assetMap: {
    symbols: { btc: 'bitcoin', sol: 'solana' },
    names: { bitcoin: 'bitcoin', solana: 'solana', 'bitcoin cash': 'bitcoin-cash' },
    logos: {
      bitcoin: 'https://example.test/bitcoin.png',
      solana: 'https://example.test/solana.png',
      'bitcoin-cash': 'https://example.test/bch.png',
    },
    updatedAt: 0,
  },
  ...overrides,
});

describe('resolveLocationIcon', () => {
  // A supported chain should look the same here as it does everywhere else in the app, and its logo is a
  // local asset rather than a remote fetch.
  it('prefers a supported chain, by name', () => {
    expect(resolveLocationIcon('Ethereum', sources())).toEqual({ chainId: 1 });
  });

  it('matches an exchange the user has configured', () => {
    expect(resolveLocationIcon('Kraken', sources())).toEqual({ exchange: 'kraken' });
  });

  // The point of the whole exercise: a chain the app knows nothing about is named after a coin it does know.
  it('falls back to the coin the place is named after', () => {
    expect(resolveLocationIcon('Bitcoin', sources())).toEqual({ logoUrl: 'https://example.test/bitcoin.png' });
    expect(resolveLocationIcon('Solana', sources())).toEqual({ logoUrl: 'https://example.test/solana.png' });
  });

  it('handles a multi-word coin name', () => {
    expect(resolveLocationIcon('Bitcoin Cash', sources())).toEqual({ logoUrl: 'https://example.test/bch.png' });
  });

  it('ignores case and surrounding whitespace', () => {
    expect(resolveLocationIcon('  bitcoin cash  ', sources())).toEqual({ logoUrl: 'https://example.test/bch.png' });
    expect(resolveLocationIcon('ETHEREUM', sources())).toEqual({ chainId: 1 });
  });

  it('accepts a ticker for someone who typed BTC rather than Bitcoin', () => {
    expect(resolveLocationIcon('BTC', sources())).toEqual({ logoUrl: 'https://example.test/bitcoin.png' });
  });

  // A wallet brand or a shelf in a safe is not a picture of anything, and the caller draws its placeholder.
  it('resolves nothing for a place that is not an asset', () => {
    expect(resolveLocationIcon('Ledger Nano', sources())).toEqual({});
    expect(resolveLocationIcon('cold storage', sources())).toEqual({});
    expect(resolveLocationIcon('', sources())).toEqual({});
  });

  // The map arrives with a sync, so every lookup has to survive not having it yet.
  it('resolves nothing when the asset map has not been fetched', () => {
    expect(resolveLocationIcon('Bitcoin', sources({ assetMap: undefined }))).toEqual({});
  });

  // A map stored before names existed must not throw on the new lookup.
  it('survives an asset map stored in the older shape', () => {
    const older = { symbols: { btc: 'bitcoin' }, logos: { bitcoin: 'https://example.test/bitcoin.png' }, updatedAt: 0 };

    expect(resolveLocationIcon('Bitcoin', sources({ assetMap: older as never }))).toEqual({});
    expect(resolveLocationIcon('BTC', sources({ assetMap: older as never }))).toEqual({
      logoUrl: 'https://example.test/bitcoin.png',
    });
  });

  it('resolves nothing when the coin is known but has no icon', () => {
    const withoutLogo = { symbols: {}, names: { bitcoin: 'bitcoin' }, logos: {}, updatedAt: 0 };

    expect(resolveLocationIcon('Bitcoin', sources({ assetMap: withoutLogo }))).toEqual({});
  });
});
