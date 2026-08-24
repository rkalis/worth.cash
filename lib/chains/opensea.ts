import { ChainId } from '@revoke.cash/chains';

// OpenSea addresses chains by its own slug rather than by chain id. Only the chains listed here have an
// OpenSea marketplace, so only these can have a floor price; NFTs on any other chain are shown without one.
export const OPENSEA_CHAIN_SLUGS: Record<number, string> = {
  [ChainId.EthereumMainnet]: 'ethereum',
  [ChainId.PolygonMainnet]: 'matic',
  [ChainId.Base]: 'base',
  [ChainId.ArbitrumOne]: 'arbitrum',
  [ChainId.ArbitrumNova]: 'arbitrum_nova',
  [ChainId.OPMainnet]: 'optimism',
  [ChainId['AvalancheC-Chain']]: 'avalanche',
  [ChainId.Blast]: 'blast',
  [ChainId.Zora]: 'zora',
  [ChainId.SeiNetwork]: 'sei',
  [ChainId.Soneium]: 'soneium',
  [ChainId.ApeChain]: 'ape_chain',
  [ChainId.KaiaMainnet]: 'klaytn', // OpenSea still calls Kaia by its former name
  [ChainId.Shape]: 'shape',
  [ChainId.Unichain]: 'unichain',
  [ChainId.Abstract]: 'abstract',
  [ChainId.Berachain]: 'berachain',
  [ChainId.RoninMainnet]: 'ronin',
  [ChainId.FlowEVMMainnet]: 'flow',
  [ChainId.EthereumSepolia]: 'sepolia',
};

export const getOpenSeaChainSlug = (chainId: number): string | undefined => OPENSEA_CHAIN_SLUGS[chainId];
