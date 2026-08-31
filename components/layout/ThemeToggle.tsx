'use client';

import Button from 'components/ui/Button';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'worth.cash-theme';

export const applyTheme = (theme: Theme) => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem(THEME_STORAGE_KEY, theme);
};

const ThemeToggle = () => {
  const [theme, setTheme] = useState<Theme>('dark');

  // Read on mount rather than during render: the server has no idea what the user picked, and reading
  // during render would produce markup that does not match what the inline boot script already applied.
  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  return (
    <Button
      variant="tertiary"
      size="sm"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        applyTheme(next);
      }}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </Button>
  );
};

export default ThemeToggle;
