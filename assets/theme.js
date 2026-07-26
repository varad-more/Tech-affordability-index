/**
 * Theme toggle, shared by every page.
 *
 * The choice is stored so it survives navigation between the index and the
 * method page — a toggle that silently reset on every link would read as a bug.
 * Pages that draw charts import `applyTheme` and pass a redraw callback, since
 * some marks resolve their ink from the surface colour and must be rebuilt.
 */

const KEY = 'tai-theme';

const systemPrefersDark = () =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

export function currentTheme() {
  return document.documentElement.dataset.theme || (systemPrefersDark() ? 'dark' : 'light');
}

function label(theme) {
  return theme === 'dark' ? 'Light' : 'Dark';
}

/**
 * @param {Function} [onChange] called after the theme flips, for chart redraws
 */
export function initTheme(onChange) {
  // Reading has to be guarded as well as writing. Blocked cookies and some
  // private-browsing modes make `localStorage` throw on *access*, not just on
  // write — and because this runs inside the page's load path, one throw here
  // took the entire site down rather than just losing the stored preference.
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // No stored preference available; fall back to the system setting.
  }

  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }

  const button = document.getElementById('theme-toggle');
  if (!button) return;

  button.textContent = label(currentTheme());

  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;

    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private browsing can refuse writes; the toggle still works for this page.
    }

    button.textContent = label(next);
    onChange?.(next);
  });
}
