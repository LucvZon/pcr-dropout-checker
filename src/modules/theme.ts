export interface ThemeManagerOptions {
  toggleElement: HTMLInputElement;
  onThemeChanged?: () => void;
}

export function initThemeManager({ toggleElement, onThemeChanged }: ThemeManagerOptions): void {
  function applyTheme(theme: string) {
    if (theme === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      toggleElement.checked = isDark;
    } else {
      document.documentElement.setAttribute('data-theme', theme);
      toggleElement.checked = theme === 'dark';
    }

    if (onThemeChanged) {
      onThemeChanged();
    }
  }

  // Load saved theme (default to system on first visit)
  let savedTheme = localStorage.getItem('pcr-theme') || 'system';
  applyTheme(savedTheme);

  // Listen for user toggling the switch
  toggleElement.addEventListener('change', () => {
    const newTheme = toggleElement.checked ? 'dark' : 'light';
    localStorage.setItem('pcr-theme', newTheme);
    savedTheme = newTheme;
    applyTheme(newTheme);
  });

  // Automatically update if the OS changes theme while the app is open
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (savedTheme === 'system') {
      applyTheme('system');
    }
  });
}