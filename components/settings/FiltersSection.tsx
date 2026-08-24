'use client';

import Card from 'components/ui/Card';
import Input from 'components/ui/Input';
import Toggle from 'components/ui/Toggle';
import { useSettings } from 'lib/hooks/useSettings';

const FiltersSection = () => {
  const { settings, updateSettings } = useSettings();

  return (
    <Card title="Spam and dust filters" bodyClassName="flex flex-col gap-1">
      <p className="text-xs text-zinc-500 mb-2">
        Filtered positions are never deleted. They stay visible under "show filtered" on the portfolio page, and any
        token can be permanently shown or hidden from its row there.
      </p>

      <Toggle
        label="Hide assets with no price"
        description="A token CoinGecko cannot price, or that has too little liquidity for its price to be meaningful, is almost always worthless. Also hides NFT collections with no floor price."
        checked={settings.spam.hideUnpricedTokens}
        onChange={(checked) => updateSettings({ spam: { ...settings.spam, hideUnpricedTokens: checked } })}
      />

      <Toggle
        label="Use spam heuristics"
        description="Flags tokens whose name or symbol advertises a website, uses airdrop bait wording, or relies on lookalike characters."
        checked={settings.spam.useSpamHeuristics}
        onChange={(checked) => updateSettings({ spam: { ...settings.spam, useSpamHeuristics: checked } })}
      />

      <div className="pt-2 max-w-48">
        <Input
          name="dust-threshold"
          label="Dust threshold (USD)"
          type="number"
          min={0}
          step={0.5}
          hint="Positions worth less than this are hidden, including NFT collections valued at their floor."
          value={settings.spam.dustThresholdUsd}
          onChange={(event) =>
            updateSettings({
              spam: { ...settings.spam, dustThresholdUsd: Math.max(0, Number(event.target.value) || 0) },
            })
          }
        />
      </div>
    </Card>
  );
};

export default FiltersSection;
