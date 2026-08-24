import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  action?: ReactNode;
}

const EmptyState = ({ title, description, action }: Props) => (
  <div className="flex flex-col items-center justify-center text-center py-12 px-4 gap-2">
    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
    {description ? <p className="text-xs text-zinc-500 max-w-sm">{description}</p> : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
);

export default EmptyState;
