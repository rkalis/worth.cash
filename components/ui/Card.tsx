import { cn } from 'lib/utils/classnames';
import type { ReactNode } from 'react';

interface Props {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

const Card = ({ title, action, className, bodyClassName, children }: Props) => (
  <section className={cn('border border-zinc-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-black', className)}>
    {title || action ? (
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        {typeof title === 'string' ? <h2 className="text-sm font-semibold">{title}</h2> : title}
        {action}
      </header>
    ) : null}
    <div className={cn('p-4', bodyClassName)}>{children}</div>
  </section>
);

export default Card;
