'use client';

import Card from 'components/ui/Card';
import InfoTooltip from 'components/ui/InfoTooltip';
import Input from 'components/ui/Input';
import Toggle from 'components/ui/Toggle';
import { useSettings } from 'lib/hooks/useSettings';

const FiltersSection = () => {
  const { settings, updateSettings } = useSettings();

  return (
    <Card
      title={
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          Spam and dust filters
          <InfoTooltip tooltip="Filtered positions are never deleted: they stay under &quot;show filtered&quot; on the portfolio page, and any token can be permanently shown or hidden from its row there." />
        </h2>
      }
      bodyClassName="flex flex-col gap-1"
    >
      <Toggle
        label="Hide assets with no price"
        tooltip="A token CoinGecko cannot price, or with too little liquidity for its price to be meaningful, is almost always worthless. Also hides NFT collections with no floor price."
        checked={settings.spam.hideUnpricedTokens}
        onChange={(checked) => updateSettings({ spam: { ...settings.spam, hideUnpricedTokens: checked } })}
      />

      <Toggle
        label="Use spam heuristics"
        tooltip="Flags tokens whose name or symbol advertises a website, uses airdrop bait wording, or relies on lookalike characters."
        checked={settings.spam.useSpamHeuristics}
        onChange={(checked) => updateSettings({ spam: { ...settings.spam, useSpamHeuristics: checked } })}
      />

      <div className="pt-2 flex flex-wrap gap-4">
        <div className="max-w-48">
          <Input
            name="dust-threshold-amount"
            label="Minimum balance"
            type="number"
            min={0}
            step={0.000001}
            tooltip="Quantities below this are treated as nothing at all, whatever they might be worth. Catches wei-sized remainders and rounding residue."
            value={settings.spam.dustThresholdAmount}
            onChange={(event) =>
              updateSettings({
                spam: { ...settings.spam, dustThresholdAmount: Math.max(0, Number(event.target.value) || 0) },
              })
            }
          />
        </div>

        <div className="max-w-48">
          <Input
            name="dust-threshold"
            label="Dust threshold (USD)"
            type="number"
            min={0}
            step={0.5}
            tooltip="Positions worth less than this are hidden, including NFT collections valued at their floor."
            value={settings.spam.dustThresholdUsd}
            onChange={(event) =>
              updateSettings({
                spam: { ...settings.spam, dustThresholdUsd: Math.max(0, Number(event.target.value) || 0) },
              })
            }
          />
        </div>
      </div>
    </Card>
  );
};

export default FiltersSection;
