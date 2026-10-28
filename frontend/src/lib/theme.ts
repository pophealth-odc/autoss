import { useCallback, useEffect, useState } from 'react';
import { KEYS, loadString, removeKey, saveString } from './storage';

export type ThemeChoice = 'system' | 'light' | 'dark';

function readChoice(): ThemeChoice {
  const value = loadString(KEYS.theme);
  return value === 'light' || value === 'dark' ? value : 'system';
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = choice;
}

export function useTheme(): { choice: ThemeChoice; setChoice: (choice: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    apply(choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    if (next === 'system') removeKey(KEYS.theme);
    else saveString(KEYS.theme, next);
    setChoiceState(next);
  }, []);

  return { choice, setChoice };
}
