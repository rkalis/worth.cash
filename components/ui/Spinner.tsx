import { cn } from 'lib/utils/classnames';

const Spinner = ({ className }: { className?: string }) => (
  <svg
    className={cn('animate-spin size-4', className)}
    viewBox="0 0 24 24"
    fill="none"
    role="status"
    aria-label="Loading"
  >
    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z" />
  </svg>
);

export default Spinner;
