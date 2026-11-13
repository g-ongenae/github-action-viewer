// Small DOM helpers. The page is built with DOM APIs only: text goes through `textContent`, never
// through markup, so text written by other people (commit titles, branch and author names) can
// never become HTML. Updates only touch what changed, so that re-rendering keeps the reader's
// focus, text selection and expanded lines.

import { safeGitHubUrl } from './urls.ts';

/** Creates an element with an optional class name. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className !== undefined) {
    created.className = className;
  }
  return created;
}

/**
 * Sets the text of a node if it differs. Setting identical text would still replace the text node
 * and clear a selection inside it.
 */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

/** Sets an attribute if it differs; removes it for null. */
export function setAttribute(target: Element, name: string, value: string | null): void {
  if (value === null) {
    if (target.hasAttribute(name)) {
      target.removeAttribute(name);
    }
  } else if (target.getAttribute(name) !== value) {
    target.setAttribute(name, value);
  }
}

/** Sets `className` if it differs. */
export function setClassName(target: Element, className: string): void {
  if (target.getAttribute('class') !== className) {
    target.setAttribute('class', className);
  }
}

/**
 * Makes `parent`'s children match `items`, in order, reusing the child that has the same key
 * (`data-key`). Children without a match are removed, then each item's element is created or
 * updated, and moved only if it is not already in place, so that an unchanged list moves nothing.
 */
export function reconcile<T>(
  parent: Element,
  items: readonly T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (target: HTMLElement, item: T) => void,
): void {
  const keys = new Set(items.map(keyOf));
  const existing = new Map<string, HTMLElement>();
  for (const child of [...parent.children]) {
    const key = child instanceof HTMLElement ? child.dataset.key : undefined;
    if (key === undefined || !keys.has(key) || existing.has(key)) {
      child.remove();
    } else {
      existing.set(key, child as HTMLElement);
    }
  }
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    let target = existing.get(key);
    existing.delete(key);
    if (target === undefined) {
      target = create(item);
      target.dataset.key = key;
    }
    update(target, item);
    if (target === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      parent.insertBefore(target, cursor);
    }
  }
}

/**
 * Makes `container` hold a link to `url` with `text` when the URL is an allowed GitHub URL (see
 * `safeGitHubUrl`), or the text alone otherwise. Links open in a new tab without giving it a
 * handle on this page.
 */
export function setLink(
  container: Element,
  url: string | null,
  text: string,
  options: { readonly title?: string | null; readonly className?: string } = {},
): void {
  const href = url === null ? null : safeGitHubUrl(url);
  const tag = href === null ? 'SPAN' : 'A';
  let target = container.firstElementChild;
  if (target?.tagName !== tag || container.childNodes.length !== 1) {
    target = href === null ? element('span') : element('a');
    container.replaceChildren(target);
  }
  if (options.className !== undefined) {
    setClassName(target, options.className);
  }
  if (href !== null) {
    setAttribute(target, 'href', href);
    setAttribute(target, 'target', '_blank');
    setAttribute(target, 'rel', 'noopener noreferrer');
  }
  setAttribute(target, 'title', options.title ?? null);
  setText(target, text);
}
