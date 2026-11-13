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
 * updated.
 *
 * Moving a node detaches it, which loses state the reader cares about, so as few nodes as
 * possible move: the longest run of kept children already in the right relative order stays
 * where it is, and only the others are moved (when one repository jumps to the top, only that
 * one moves). Moves use {@link moveNode}.
 */
export function reconcile<T>(
  parent: Element,
  items: readonly T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (target: HTMLElement, item: T) => void,
): void {
  const keys = new Set(items.map(keyOf));
  const existing = new Map<string, { readonly element: HTMLElement; readonly index: number }>();
  for (const child of [...parent.children]) {
    const key = child instanceof HTMLElement ? child.dataset.key : undefined;
    if (key === undefined || !keys.has(key) || existing.has(key)) {
      child.remove();
    } else {
      existing.set(key, { element: child as HTMLElement, index: existing.size });
    }
  }

  const targets: HTMLElement[] = [];
  const oldIndexes: number[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const found = existing.get(key);
    existing.delete(key);
    let target = found?.element;
    if (target === undefined) {
      target = create(item);
      target.dataset.key = key;
    }
    update(target, item);
    targets.push(target);
    oldIndexes.push(found?.index ?? -1);
  }

  // Place from the end: each element that is not part of the stable run goes right before the
  // element that follows it, which is already in its final place.
  const stable = longestIncreasingRun(oldIndexes);
  let next: Element | null = null;
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    if (target === undefined) {
      continue;
    }
    if (
      !stable.has(index) &&
      (target.parentNode !== parent || target.nextElementSibling !== next)
    ) {
      moveNode(parent, target, next);
    }
    next = target;
  }
}

/**
 * Puts `node` into `parent` before `reference` (at the end for null). Uses `moveBefore` when the
 * browser has it and the move is allowed (a node already in the same connected tree), which keeps
 * the focus and other state of the moved subtree, and `insertBefore` otherwise (new nodes, older
 * browsers). Neither keeps a text selection inside the moved node: the renderer restores it.
 */
export function moveNode(parent: Element, node: Element, reference: Element | null): void {
  if (
    typeof parent.moveBefore === 'function' &&
    node.parentNode !== null &&
    node.isConnected &&
    parent.isConnected &&
    node.getRootNode() === parent.getRootNode()
  ) {
    try {
      parent.moveBefore(node, reference);
      return;
    } catch {
      // Fall through: the plain insertion always works.
    }
  }
  parent.insertBefore(node, reference);
}

/**
 * Positions (in `values`) of a longest strictly increasing subsequence of the non-negative
 * values; negative values (new elements) are never part of it. O(n log n).
 */
export function longestIncreasingRun(values: readonly number[]): Set<number> {
  /** `tails[k]`: position of the smallest last value of an increasing run of length k + 1. */
  const tails: number[] = [];
  const previous: number[] = values.map(() => -1);
  values.forEach((value, position) => {
    if (value < 0) {
      return;
    }
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] ?? 0] ?? 0) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[position] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = position;
  });
  const run = new Set<number>();
  for (let position = tails.at(-1) ?? -1; position >= 0; position = previous[position] ?? -1) {
    run.add(position);
  }
  return run;
}

/** A text selection, by its boundary points, to put back after the DOM changed around it. */
export interface SavedSelection {
  readonly anchorNode: Node;
  readonly anchorOffset: number;
  readonly focusNode: Node;
  readonly focusOffset: number;
}

/** The document's current selection, if it is a non-empty range; null otherwise. */
export function saveSelection(document: Document): SavedSelection | null {
  const selection = document.getSelection();
  if (
    selection === null ||
    selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null
  ) {
    return null;
  }
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

/**
 * Puts a saved selection back if moving nodes collapsed it, as long as its nodes are still on
 * the page with the same length (text the update changed is not reselected).
 */
export function restoreSelection(document: Document, saved: SavedSelection | null): void {
  const selection = document.getSelection();
  if (saved === null || selection === null) {
    return;
  }
  const { anchorNode, anchorOffset, focusNode, focusOffset } = saved;
  const unchanged =
    selection.anchorNode === anchorNode &&
    selection.anchorOffset === anchorOffset &&
    selection.focusNode === focusNode &&
    selection.focusOffset === focusOffset;
  const fits = (node: Node, offset: number): boolean =>
    node.isConnected &&
    offset <=
      (node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length);
  if (!unchanged && fits(anchorNode, anchorOffset) && fits(focusNode, focusOffset)) {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
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
