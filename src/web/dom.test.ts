// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  longestIncreasingRun,
  moveNode,
  reconcile,
  restoreSelection,
  saveSelection,
} from './dom.ts';

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

describe('longestIncreasingRun', () => {
  it.each([
    [[], []],
    [
      [0, 1, 2, 3],
      [0, 1, 2, 3],
    ],
    [
      [1, 2, 3, 0],
      [0, 1, 2],
    ],
    [
      [3, 0, 1, 2],
      [1, 2, 3],
    ],
    [[3, 2, 1, 0], [3]],
    [
      [-1, 0, -1, 1],
      [1, 3],
    ],
    [
      [2, 0, 3, 1, 4],
      [1, 3, 4],
    ],
  ])('%j keeps positions %j', (values, expected) => {
    expect([...longestIncreasingRun(values)].sort((a, b) => a - b)).toEqual(expected);
  });
});

describe('reconcile', () => {
  let list: HTMLElement;
  /** Nodes passed to a move or insertion, in order. */
  let moved: string[];

  beforeEach(() => {
    document.body.innerHTML = '<ul id="list"></ul>';
    list = byId('list');
    render(['a', 'b', 'c', 'd']);
    moved = [];
    // happy-dom has no `moveBefore`: give this list one, and watch both ways in.
    const record = (node: Node): void => {
      moved.push((node as HTMLElement).dataset.key ?? '?');
    };
    const insertBefore = list.insertBefore.bind(list);
    Object.assign(list, {
      moveBefore: (node: Node, child: Node | null) => {
        record(node);
        insertBefore(node, child);
      },
    });
    vi.spyOn(list, 'insertBefore').mockImplementation((node, child) => {
      record(node);
      return insertBefore(node, child);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(keys: readonly string[]): void {
    reconcile(
      list,
      keys,
      (key) => key,
      () => document.createElement('li'),
      (item, key) => {
        item.textContent = key;
      },
    );
  }

  const order = (): string[] => [...list.children].map((child) => child.textContent);

  it('moves nothing when the order is unchanged', () => {
    const before = [...list.children];
    render(['a', 'b', 'c', 'd']);
    expect(moved).toEqual([]);
    expect([...list.children]).toEqual(before);
  });

  it('moves only the item that jumps to the top', () => {
    render(['d', 'a', 'b', 'c']);
    expect(order()).toEqual(['d', 'a', 'b', 'c']);
    expect(moved).toEqual(['d']);
  });

  it('moves only the item that drops to the bottom', () => {
    render(['b', 'c', 'd', 'a']);
    expect(order()).toEqual(['b', 'c', 'd', 'a']);
    expect(moved).toEqual(['a']);
  });

  it('removes without moving the others, and inserts only the new item', () => {
    render(['a', 'c', 'x', 'd']);
    expect(order()).toEqual(['a', 'c', 'x', 'd']);
    expect(moved).toEqual(['x']);
  });

  it('reverses with the fewest moves', () => {
    render(['d', 'c', 'b', 'a']);
    expect(order()).toEqual(['d', 'c', 'b', 'a']);
    expect(moved).toHaveLength(3);
  });
});

describe('moveNode', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="list"><li id="a"></li><li id="b"></li></ul>';
  });

  const get = byId;

  it('uses moveBefore for a connected node when the browser has it', () => {
    const moveBefore = vi.fn();
    const list = Object.assign(get('list'), { moveBefore });
    moveNode(list, get('b'), get('a'));
    expect(moveBefore).toHaveBeenCalledWith(get('b'), get('a'));
  });

  it('inserts a new node, and falls back to insertBefore when moveBefore throws', () => {
    const moveBefore = vi.fn(() => {
      throw new DOMException('no', 'HierarchyRequestError');
    });
    const list = Object.assign(get('list'), { moveBefore });
    const fresh = document.createElement('li');
    moveNode(list, fresh, null);
    expect(moveBefore).not.toHaveBeenCalled();
    expect(list.lastElementChild).toBe(fresh);

    moveNode(list, get('b'), get('a'));
    expect(moveBefore).toHaveBeenCalledTimes(1);
    expect(list.firstElementChild).toBe(get('b'));
  });
});

describe('saveSelection and restoreSelection', () => {
  it('put a collapsed selection back on nodes that are still there', () => {
    document.body.innerHTML = '<p id="p">Load the October partitions</p>';
    const text = document.getElementById('p')?.firstChild as Text;
    const selection = document.getSelection();
    selection?.setBaseAndExtent(text, 0, text, 8);
    const saved = saveSelection(document);
    expect(saved).not.toBeNull();

    selection?.removeAllRanges();
    restoreSelection(document, saved);
    expect(document.getSelection()?.toString()).toBe('Load the');
  });

  it('do not reselect text that no longer exists', () => {
    document.body.innerHTML = '<p id="p">Load the October partitions</p>';
    const paragraph = byId('p');
    const text = paragraph.firstChild as Text;
    document.getSelection()?.setBaseAndExtent(text, 0, text, 8);
    const saved = saveSelection(document);
    document.getSelection()?.removeAllRanges();
    paragraph.textContent = 'Other';
    restoreSelection(document, saved);
    expect(document.getSelection()?.toString()).toBe('');
  });

  it('save nothing for an empty selection', () => {
    document.getSelection()?.removeAllRanges();
    expect(saveSelection(document)).toBeNull();
  });
});
