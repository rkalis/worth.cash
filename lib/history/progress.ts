// The steps a reconstruction goes through, in the order they run.
//
// Reported as a list rather than as "whatever is happening right now", so the UI can show what is finished,
// what is running and what is still to come. A single line saying "fetching prices: 12 / 40" tells you what
// it is doing but not how much of the job is left.
export const RECONSTRUCTION_PHASES = [
  'exchange-history',
  'resolving-blocks',
  'reading-native-balances',
  'fetching-prices',
  'fetching-nft-floors',
  'valuing-positions',
] as const;

export type ReconstructionPhase = (typeof RECONSTRUCTION_PHASES)[number];

export type ReconstructionStepStatus = 'pending' | 'running' | 'done' | 'skipped';

export interface ReconstructionStep {
  phase: ReconstructionPhase;
  status: ReconstructionStepStatus;
  completed: number;
  total: number;
}

export const RECONSTRUCTION_PHASE_LABELS: Record<ReconstructionPhase, string> = {
  'exchange-history': 'Fetch exchange history',
  'resolving-blocks': 'Resolve block heights',
  'reading-native-balances': 'Read native balances',
  'fetching-prices': 'Fetch historical prices',
  'fetching-nft-floors': 'Fetch NFT floor prices',
  'valuing-positions': 'Value what was held',
};

// What each step is counting, so a progress line reads "8 of 40 chains" rather than a bare fraction.
export const RECONSTRUCTION_PHASE_UNITS: Record<ReconstructionPhase, string> = {
  'exchange-history': 'accounts',
  'resolving-blocks': 'chains',
  'reading-native-balances': 'chains',
  'fetching-prices': 'assets',
  'fetching-nft-floors': 'collections',
  'valuing-positions': 'positions',
};

export type ReconstructionProgressListener = (steps: ReconstructionStep[]) => void;

export interface ReconstructionProgressReporter {
  // Marks a step as running. A total of zero completes it immediately as skipped: there was nothing to do,
  // which is worth showing as its own outcome rather than as a step that finished suspiciously fast.
  start: (phase: ReconstructionPhase, total: number) => void;
  advance: (phase: ReconstructionPhase, completed: number) => void;
  complete: (phase: ReconstructionPhase) => void;
  skip: (phase: ReconstructionPhase) => void;
  // Every step still pending, marked as skipped, for when a reconstruction stops early.
  skipRemaining: () => void;
}

export const createReconstructionProgress = (
  onProgress?: ReconstructionProgressListener,
): ReconstructionProgressReporter => {
  const steps: ReconstructionStep[] = RECONSTRUCTION_PHASES.map((phase) => ({
    phase,
    status: 'pending',
    completed: 0,
    total: 0,
  }));

  // A fresh array of fresh objects each time. React compares by reference, and mutating the steps in place
  // would leave a memoised list rendering the state it first saw.
  const publish = () => onProgress?.(steps.map((step) => ({ ...step })));

  const update = (phase: ReconstructionPhase, changes: Partial<ReconstructionStep>) => {
    const step = steps.find((candidate) => candidate.phase === phase);
    if (!step) return;

    Object.assign(step, changes);
    publish();
  };

  return {
    start: (phase, total) => {
      update(phase, total === 0 ? { status: 'skipped', total: 0, completed: 0 } : { status: 'running', total });
    },
    advance: (phase, completed) => update(phase, { completed }),
    complete: (phase) => {
      const step = steps.find((candidate) => candidate.phase === phase);
      update(phase, { status: 'done', completed: step?.total ?? 0 });
    },
    skip: (phase) => update(phase, { status: 'skipped' }),
    skipRemaining: () => {
      for (const step of steps) {
        if (step.status === 'pending' || step.status === 'running') step.status = 'skipped';
      }
      publish();
    },
  };
};
