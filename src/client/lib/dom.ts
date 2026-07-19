type Attrs = Record<string, string | boolean | EventListener>;

/**
 * Tiny hyperscript helper. All dynamic content goes through `textContent`
 * (never innerHTML), so untrusted strings like guest names render inert.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      node.addEventListener(name.replace(/^on/, ''), value);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(name, '');
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

let toastRegion: HTMLElement | null = null;

/**
 * Create the live region up front. Screen readers announce reliably only when
 * the aria-live container already exists before content is inserted, so this
 * is called once at startup rather than lazily on the first toast.
 */
export function initToastRegion(): void {
  if (toastRegion) return;
  toastRegion = el('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' });
  document.body.append(toastRegion);
}

/**
 * Screen-reader friendly notification. Info toasts auto-dismiss after 4s;
 * error toasts persist (they often carry recovery instructions) until
 * dismissed. Either can be dismissed with the close button, and hovering or
 * focusing pauses the auto-dismiss timer (WCAG 2.2.1).
 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  initToastRegion();
  const dismiss = (): void => {
    if (!item.isConnected) return;
    item.classList.add('toast-out');
    setTimeout(() => item.remove(), 300);
  };
  const close = el(
    'button',
    { class: 'toast-close', 'aria-label': 'Dismiss', onclick: dismiss },
    '×',
  );
  const item = el('div', { class: `toast toast-${kind}` }, el('span', {}, message), close);
  toastRegion?.append(item);

  if (kind === 'error') return; // Errors stay until dismissed.

  let timer = window.setTimeout(dismiss, 4000);
  item.addEventListener('mouseenter', () => clearTimeout(timer));
  item.addEventListener('focusin', () => clearTimeout(timer));
  const resume = (): void => {
    timer = window.setTimeout(dismiss, 4000);
  };
  item.addEventListener('mouseleave', resume);
  item.addEventListener('focusout', resume);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
