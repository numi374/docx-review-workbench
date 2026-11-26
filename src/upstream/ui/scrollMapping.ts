// Anchor-based scroll synchronization between the panels (FR-22, docs/architecture.md). All
// panels show the same HTML, so a block has the same `data-anchor` in each. Blocks visible in two
// panels are paired by their offsets; a scroll position between two paired blocks maps
// proportionally to the same place between them in the other panel, so regions shown in one panel
// only (an inserted passage, a deleted tail) don't make the other panel jump.

export interface BlockOffset {
  anchor: string;
  /** Offset of the block's top from the top of the panel's scrollable content, in pixels. */
  top: number;
}

export interface OffsetPair {
  source: number;
  target: number;
}

/**
 * Pairs the source blocks with the same anchors in the target, ordered by source offset. Pairs
 * that would make the target offset go backwards (e.g. reordered content) are dropped, so the
 * mapping stays monotonic.
 */
export function pairOffsets(source: readonly BlockOffset[], target: readonly BlockOffset[]): OffsetPair[] {
  const targetTop = new Map(target.map((block) => [block.anchor, block.top]));
  const pairs: OffsetPair[] = [];
  for (const block of [...source].sort((a, b) => a.top - b.top)) {
    const top = targetTop.get(block.anchor);
    if (top === undefined) continue;
    const last = pairs.at(-1);
    if (last && (top < last.target || block.top === last.source)) continue;
    pairs.push({ source: block.top, target: top });
  }
  return pairs;
}

/** The target scroll offset for a source scroll offset; `null` when nothing is paired. */
export function mapScrollTop(pairs: readonly OffsetPair[], scrollTop: number): number | null {
  if (pairs.length === 0) return null;
  // The last pair at or above the scroll position.
  let low = 0;
  let high = pairs.length - 1;
  let before = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (pairs[middle]!.source <= scrollTop) {
      before = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (before === -1) {
    const first = pairs[0]!;
    return first.target - (first.source - scrollTop);
  }
  const a = pairs[before]!;
  const b = pairs[before + 1];
  if (!b) return a.target + (scrollTop - a.source);
  return a.target + ((scrollTop - a.source) / (b.source - a.source)) * (b.target - a.target);
}

/** Offsets of the visible `data-anchor` blocks in a panel (hidden blocks have no layout box). */
export function measureBlocks(scroller: HTMLElement): BlockOffset[] {
  const root = scroller.shadowRoot ?? scroller;
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const blocks: BlockOffset[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('[data-anchor]')) {
    if (element.getClientRects().length === 0) continue;
    blocks.push({ anchor: element.dataset.anchor!, top: element.getBoundingClientRect().top - origin });
  }
  return blocks;
}


