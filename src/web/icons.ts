// State icons: one distinct shape per run state, so that states can be told apart without colour.
// Drawn as SVG with the DOM (no markup strings, no inline styles: the CSP forbids them) in a
// 16×16 box, stroked with `currentColor` so that CSS picks the colour.

import type { RunState } from '../core/run-state.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** A circle around the glyph; dashed for states that are not (or no longer) really running. */
type Ring = 'solid' | 'dashed' | 'track';

interface IconShape {
  readonly ring: Ring;
  /** Path data of the glyph inside the ring. */
  readonly glyph: string;
  /** Glyph filled rather than stroked (dots). */
  readonly filled?: boolean;
}

const SHAPES: Readonly<Record<RunState, IconShape>> = {
  // A quarter arc over a faint track, spun by CSS.
  in_progress: { ring: 'track', glyph: 'M8 1.5a6.5 6.5 0 0 1 6.5 6.5' },
  queued: {
    ring: 'dashed',
    glyph: 'M8 6.6a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8z',
    filled: true,
  },
  waiting: { ring: 'solid', glyph: 'M6.3 5.3v5.4M9.7 5.3v5.4' },
  failure: { ring: 'solid', glyph: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8' },
  timed_out: { ring: 'solid', glyph: 'M8 4.4V8l2.6 1.6' },
  action_required: { ring: 'solid', glyph: 'M8 4.3v4.6M8 11.2v.4' },
  cancelled: { ring: 'solid', glyph: 'M3.4 12.6l9.2-9.2' },
  unknown: { ring: 'dashed', glyph: 'M6.1 6.3a2 2 0 1 1 2.6 1.9c-.5.2-.7.6-.7 1.1v.4M8 11.4v.3' },
  stale: { ring: 'dashed', glyph: 'M8 4.8V8h2.6' },
  success: { ring: 'solid', glyph: 'M5 8.3l2 2 4-4.4' },
  neutral: { ring: 'solid', glyph: 'M5.2 8h5.6' },
  skipped: { ring: 'dashed', glyph: 'M5 8h5M8.3 5.6L10.7 8l-2.4 2.4' },
};

/** The icon of `state`, decorative (`aria-hidden`): its text label always comes with it. */
export function stateIcon(state: RunState): SVGSVGElement {
  const shape = SHAPES[state];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${state}`);
  svg.dataset.state = state;

  const ring = document.createElementNS(SVG, 'circle');
  ring.setAttribute('cx', '8');
  ring.setAttribute('cy', '8');
  ring.setAttribute('r', '6.5');
  ring.setAttribute('class', `icon-ring icon-ring-${shape.ring}`);
  svg.append(ring);

  const glyph = document.createElementNS(SVG, 'path');
  glyph.setAttribute('d', shape.glyph);
  glyph.setAttribute(
    'class',
    shape.filled === true ? 'icon-glyph icon-glyph-filled' : 'icon-glyph',
  );
  svg.append(glyph);
  return svg;
}

/**
 * Puts the icon of `state` in `container`, just before its `.state-label` child (or first if
 * there is none); leaves an icon that already shows `state` alone.
 */
export function setStateIcon(container: Element, state: RunState): void {
  const current = container.querySelector(':scope > svg.icon');
  if (current instanceof SVGElement && current.dataset.state === state) {
    return;
  }
  const icon = stateIcon(state);
  if (current !== null) {
    current.replaceWith(icon);
  } else {
    container.insertBefore(icon, container.querySelector(':scope > .state-label'));
  }
}

/** A check mark, decorative (`aria-hidden`), for the buttons that mark a line as done. */
export function checkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon icon-check');
  const glyph = document.createElementNS(SVG, 'path');
  glyph.setAttribute('d', 'M3 8.5l3.2 3.2L13 4.8');
  glyph.setAttribute('class', 'icon-glyph');
  svg.append(glyph);
  return svg;
}
