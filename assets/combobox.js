/**
 * A text input backed by a real listbox popup.
 *
 * This replaces a `<datalist>`, which looked like the right tool and is not.
 * A datalist gives you no control over what a row says, so a county could only
 * ever be a bare string — no state, no metro, no indication that the rent basis
 * you have selected publishes nothing for it. Worse, its matching is the
 * browser's: Chrome matches anywhere in the string, Safari only at the start, so
 * typing "Seattle" found King County in one browser and nothing in the other.
 * And it only ever fires `change` on an exact match, so pressing Enter on a
 * half-typed name silently did nothing at all.
 *
 * What is implemented here is the ARIA 1.2 combobox pattern with `aria-
 * autocomplete="list"`: the input keeps focus throughout and the active row is
 * pointed at by `aria-activedescendant`, rather than focus moving into the list.
 * That is what lets Escape restore, Enter commit, and typing keep filtering
 * without the caret ever leaving the box.
 *
 * The caller owns what an item *is*. This file owns focus, keys, and ARIA.
 */

/** Rendered rows per open. Beyond this the list is a scrollbar, not a choice. */
const DEFAULT_LIMIT = 60;

/**
 * @param {HTMLInputElement} input
 * @param {object}   opts
 * @param {HTMLElement} opts.listbox   the popup element (role="listbox")
 * @param {Function} opts.source       (query) => items to show, already ranked
 * @param {Function} opts.renderRow    (item, query) => Node placed inside the row
 * @param {Function} opts.labelOf      (item) => the string the input holds when committed
 * @param {Function} opts.onCommit     (item) => void
 * @param {Function} [opts.selected]   () => the currently committed item, for reopening
 * @param {Function} [opts.emptyMessage] (query) => text shown when nothing matched
 * @param {HTMLElement} [opts.status]  live region told how many rows matched
 * @param {number} [opts.limit]
 * @returns {{ open: Function, close: Function, refresh: Function, setLabel: Function }}
 */
export function combobox(input, opts) {
  const { listbox, source, renderRow, labelOf, onCommit, selected, status } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const emptyMessage = opts.emptyMessage ?? (() => 'No matches.');

  let items = [];
  let active = -1;
  let open = false;

  const optionId = (i) => `${listbox.id}-opt-${i}`;

  function setActive(next, scroll = true) {
    const rows = listbox.children;
    if (active >= 0 && rows[active]) rows[active].setAttribute('aria-selected', 'false');

    active = next >= 0 && next < items.length ? next : -1;

    if (active < 0) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const row = rows[active];
    row.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', optionId(active));
    // `nearest` scrolls the list and nothing else. `scrollIntoView()` with its
    // defaults would scroll the *page* to bring the row to the middle, dragging
    // the whole panel around under someone who only pressed the down arrow.
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  /** Rebuild the rows for `query` and show them. */
  function paint(query) {
    const all = source(query);
    items = all.slice(0, limit);

    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const row = document.createElement('li');
      row.className = 'combo-row';
      row.id = optionId(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.appendChild(renderRow(item, query));
      frag.appendChild(row);
    });

    if (all.length > items.length) {
      const more = document.createElement('li');
      more.className = 'combo-more';
      // Not an option: it is a count, and arrowing onto a row you cannot pick
      // is a dead end. `role="presentation"` keeps it out of the option set.
      more.setAttribute('role', 'presentation');
      more.textContent = `${(all.length - items.length).toLocaleString()} more — keep typing to narrow`;
      frag.appendChild(more);
    }

    // A query that matches nothing says so. Letting the popup vanish instead
    // looks identical to the popup never having worked, and it took the only
    // affordance for backing out with it — Escape had nothing open to close.
    if (items.length === 0) {
      const none = document.createElement('li');
      none.className = 'combo-empty';
      none.setAttribute('role', 'presentation');
      none.textContent = emptyMessage(query);
      frag.appendChild(none);
    }

    listbox.replaceChildren(frag);
    listbox.hidden = false;
    // `open` tracks whether there is anything to *pick*, which is what the
    // arrow keys and Enter act on — not whether the popup is on screen.
    input.setAttribute('aria-expanded', String(items.length > 0));
    open = items.length > 0;
    active = -1;

    if (status) {
      status.textContent = items.length
        ? `${all.length.toLocaleString()} ${all.length === 1 ? 'match' : 'matches'}`
        : 'No matches';
    }
  }

  function show(query = input.value) {
    paint(query);
    if (!open) return;

    // Reopening on an unedited box should land on what is already chosen, not on
    // whatever happens to sort first.
    const current = selected?.();
    const at = current ? items.indexOf(current) : -1;
    setActive(at >= 0 ? at : 0);
  }

  function close() {
    if (listbox.hidden) return;
    listbox.hidden = true;
    listbox.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    items = [];
    active = -1;
    open = false;
  }

  /** Put the committed label back in the box, discarding a half-typed query. */
  function setLabel(text) {
    input.value = text ?? '';
  }

  function restore() {
    const current = selected?.();
    if (current) setLabel(labelOf(current));
  }

  function commit(i) {
    const item = items[i];
    if (!item) return;
    close();
    onCommit(item);
  }

  input.addEventListener('input', () => show(input.value));

  input.addEventListener('focus', () => {
    // Focusing an already-committed box should offer the whole list rather than
    // the single row that matches the text sitting in it.
    input.select();
    show('');
  });

  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          show('');
          return;
        }
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const n = items.length;
        setActive(((active < 0 ? (step > 0 ? -1 : 0) : active) + step + n) % n);
        return;
      }
      case 'Home':
        if (open) {
          event.preventDefault();
          setActive(0);
        }
        return;
      case 'End':
        if (open) {
          event.preventDefault();
          setActive(items.length - 1);
        }
        return;
      case 'PageDown':
      case 'PageUp':
        if (open) {
          event.preventDefault();
          const jump = event.key === 'PageDown' ? 8 : -8;
          setActive(Math.min(items.length - 1, Math.max(0, active + jump)));
        }
        return;
      case 'Enter':
        if (open && active >= 0) {
          // Only swallow the key when it actually picked something, so Enter in
          // a closed box still submits whatever form the input may sit in.
          event.preventDefault();
          commit(active);
        }
        return;
      case 'Escape': {
        // Escape reverts, whether or not there is a list to close. A query that
        // matched nothing leaves the box holding text that names no county,
        // and that is exactly when backing out matters most.
        const current = selected?.();
        const dirty = input.value !== (current ? labelOf(current) : '');
        if (!listbox.hidden || dirty) {
          event.preventDefault();
          close();
          restore();
        }
        return;
      }
      case 'Tab':
        // Leaving with a row highlighted takes it — the same bargain the browser
        // strikes with its own autofill, and the alternative is silently
        // discarding a choice the user could see was made.
        if (open && active >= 0) commit(active);
        else close();
        return;
      default:
    }
  });

  // `mousedown` fires before focus leaves the input, so cancelling it here is
  // what stops the blur handler from closing the list out from under the click.
  listbox.addEventListener('mousedown', (event) => event.preventDefault());

  listbox.addEventListener('click', (event) => {
    const row = event.target.closest('.combo-row');
    if (!row) return;
    commit([...listbox.children].indexOf(row));
    input.focus();
  });

  listbox.addEventListener('mousemove', (event) => {
    const row = event.target.closest('.combo-row');
    if (!row) return;
    const i = [...listbox.children].indexOf(row);
    // No scrolling on hover: the pointer is already where the user wants it, and
    // nudging the list would move the row out from under the cursor.
    if (i !== active) setActive(i, false);
  });

  input.addEventListener('blur', () => {
    close();
    restore();
  });

  return {
    open: (query = '') => {
      input.focus();
      show(query);
    },
    close,
    /** Re-run the current query in place — used when the filter behind it changes. */
    refresh: () => {
      if (open) show(input.value);
    },
    setLabel,
    isOpen: () => open,
  };
}

/**
 * Split `text` on the first case-insensitive occurrence of `query`, marking the
 * hit. Showing people *why* a row matched is most of what makes a long list
 * feel searched rather than shuffled.
 *
 * @returns {DocumentFragment}
 */
export function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;

  if (at < 0) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }

  frag.appendChild(document.createTextNode(text.slice(0, at)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(at, at + query.length);
  frag.appendChild(mark);
  frag.appendChild(document.createTextNode(text.slice(at + query.length)));
  return frag;
}
