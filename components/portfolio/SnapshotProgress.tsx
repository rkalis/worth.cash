'use client';

import { RECONSTRUCTION_PHASE_LABELS, RECONSTRUCTION_PHASE_UNITS, type ReconstructionStep } from 'lib/history/progress';
import { cn } from 'lib/utils/classnames';

interface Props {
  steps: ReconstructionStep[];
}

// What a reconstruction is doing, and what it still has to do.
//
// Every step is listed from the start, including the ones not reached yet, because the useful question
// during a slow run is "how much of this is left" rather than "what is it touching right now".
const SnapshotProgress = ({ steps }: Props) => {
  const finished = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="h-0.5 bg-zinc-100 dark:bg-zinc-900">
        <div
          className="h-full bg-brand transition-[width] duration-300 ease-expo-out"
          style={{ width: `${(finished / steps.length) * 100}%` }}
        />
      </div>

      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {steps.map((step) => (
          <li key={step.phase} className="flex items-center gap-3 px-3 py-1.5 text-xs">
            <StepMarker status={step.status} />

            <span
              className={cn(
                'truncate',
                step.status === 'running'
                  ? 'text-black dark:text-white font-medium'
                  : step.status === 'pending'
                    ? 'text-zinc-400'
                    : 'text-zinc-600 dark:text-zinc-400',
              )}
            >
              {RECONSTRUCTION_PHASE_LABELS[step.phase]}
            </span>

            <span className="ml-auto tabular text-zinc-500 shrink-0">{describeStep(step)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const describeStep = (step: ReconstructionStep): string => {
  if (step.status === 'skipped') return 'nothing to do';
  if (step.status === 'pending') return 'waiting';

  const unit = RECONSTRUCTION_PHASE_UNITS[step.phase];
  if (step.status === 'done') return `${step.total} ${unit}`;

  return `${step.completed} of ${step.total} ${unit}`;
};

// Purely decorative: the step's status is already spelled out in the text beside it, so the dot is hidden
// from assistive technology rather than repeating it.
const StepMarker = ({ status }: { status: ReconstructionStep['status'] }) => (
  <span
    aria-hidden="true"
    className={cn(
      'size-1.5 rounded-full shrink-0',
      status === 'running'
        ? 'bg-brand animate-pulse'
        : status === 'done'
          ? 'bg-green-500'
          : 'bg-zinc-300 dark:bg-zinc-700',
    )}
  />
);

export default SnapshotProgress;
