import { extractIpfsPath, gatewayCandidates } from 'lib/nfts/gateways';
import { describe, expect, it } from 'vitest';

describe('IPFS gateway fallback', () => {
  const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

  it('recognises the ipfs path on any gateway host, not just ours', () => {
    expect(extractIpfsPath(new URL(`https://some-project-cdn.example/ipfs/${CID_V0}/42.png`))).toBe(`${CID_V0}/42.png`);
  });

  it('offers the same content from the alternates, requested gateway first', () => {
    const candidates = gatewayCandidates(new URL(`https://ipfs.io/ipfs/${CID_V0}`));

    expect(candidates[0].href).toBe(`https://ipfs.io/ipfs/${CID_V0}`);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.map((url) => url.hostname)).toContain('dweb.link');
    // Every candidate serves the same content path; only the host differs.
    for (const candidate of candidates) {
      expect(candidate.pathname).toBe(`/ipfs/${CID_V0}`);
    }
  });

  it('keeps the item path when switching gateways', () => {
    const candidates = gatewayCandidates(new URL(`https://ipfs.io/ipfs/${CID_V0}/images/7.png`));

    for (const candidate of candidates) {
      expect(candidate.pathname.endsWith(`/${CID_V0}/images/7.png`)).toBe(true);
    }
  });

  it('handles v1 CIDs', () => {
    const cidV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(gatewayCandidates(new URL(`https://dweb.link/ipfs/${cidV1}`)).length).toBeGreaterThan(1);
  });

  // A URL with one host that can serve it has no alternates worth inventing.
  it('leaves a non-IPFS URL alone', () => {
    const url = new URL('https://static.example.com/art/42.png');

    expect(extractIpfsPath(url)).toBeUndefined();
    expect(gatewayCandidates(url)).toEqual([url]);
  });

  it('does not mistake a path that merely mentions ipfs', () => {
    expect(extractIpfsPath(new URL('https://example.com/ipfs/not-a-cid.png'))).toBeUndefined();
  });
});
