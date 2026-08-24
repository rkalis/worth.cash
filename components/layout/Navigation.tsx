'use client';

import { cn } from 'lib/utils/classnames';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';

const LINKS = [
  { href: '/', label: 'Portfolio' },
  { href: '/nfts', label: 'NFTs' },
  { href: '/manual', label: 'Manual' },
  { href: '/history', label: 'History' },
  { href: '/settings', label: 'Settings' },
] as const;

const Navigation = () => {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 dark:border-zinc-800 bg-white/85 dark:bg-black/85 backdrop-blur">
      <nav className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold text-sm shrink-0">
          <span className="size-2.5 rounded-full bg-brand" />
          Portfolio
        </Link>

        <div className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => {
            const isActive = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'px-3 h-8 inline-flex items-center rounded-lg text-sm transition-colors duration-150',
                  isActive
                    ? 'bg-zinc-100 dark:bg-zinc-900 font-medium'
                    : 'text-zinc-500 hover:text-black dark:hover:text-white',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
};

export default Navigation;
