const blockSelector = '[data-anchor]';

function textNodes(block, includeMarkers = false) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const element = node.parentElement;
      if (!node.length || !element.getClientRects().length || element.closest(blockSelector) !== block ||
          (!includeMarkers && element.closest('.rev-para-mark-ins, .rev-para-mark-del, .rev-ins-marker, .rev-del-marker'))) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

export function readBlock(block) {
  const spans = [];
  let text = '';
  for (const node of textNodes(block, true)) {
    const parent = node.parentElement;
    const marker = parent.closest('.rev-para-mark-ins, .rev-para-mark-del, .rev-ins-marker, .rev-del-marker');
    const id = parent.closest('[data-change-id]')?.dataset.changeId;
    const start = text.length;
    if (!marker) text += node.data;
    if (id && !parent.closest('.change-common')) spans.push({ id, start, end: text.length });
  }
  return { text, spans };
}

function offsetAt(nodes, range, start) {
  const point = range.cloneRange();
  point.collapse(start);
  let offset = 0;
  for (const node of nodes) {
    const segment = document.createRange();
    segment.selectNodeContents(node);
    const location = segment.comparePoint(point.startContainer, point.startOffset);
    if (location < 0) return offset;
    if (point.startContainer === node) return offset + point.startOffset;
    offset += node.length;
  }
  return offset;
}

export function captureAnchor(root, side) {
  const selection = window.getSelection();
  if (!selection) return null;
  const [position] = selection.getComposedRanges({ shadowRoots: [root] });
  if (!position || position.collapsed || position.startContainer.getRootNode() !== root ||
      position.endContainer.getRootNode() !== root) return null;

  const elementOf = (node) => node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const blockOf = (node) => elementOf(node).closest?.(blockSelector);
  const first = blockOf(position.startContainer);
  const last = blockOf(position.endContainer);
  const range = document.createRange();
  range.setStart(position.startContainer, position.startOffset);
  range.setEnd(position.endContainer, position.endOffset);
  const blocks = first && first === last ? [first] : [...root.querySelectorAll(blockSelector)]
    .filter((block) => range.intersectsNode(block) && block.getClientRects().length);
  const parts = blocks.map((block) => captureBlock(block, range)).filter(Boolean);
  if (!parts.length) return null;
  const model = { ...parts[0], side };
  if (parts.length > 1) {
    model.parts = parts;
    model.paragraph = parts.map((part) => part.paragraph).join('\n');
    model.quote = parts.map((part) => part.quote).join('\n');
    model.end = model.start + model.quote.length;
    model.changeId = null;
  }
  const pin = range.cloneRange();
  if (parts.length > 1) pin.collapse(selection.direction === 'backward');
  return { model, pin };
}

function captureBlock(block, range) {
  const nodes = textNodes(block);
  const paragraph = nodes.map((node) => node.data).join('');
  const start = offsetAt(nodes, range, true);
  const end = offsetAt(nodes, range, false);
  const quote = paragraph.slice(start, end);
  if (!quote.trim()) return null;
  const changeIds = new Set();
  let offset = 0;
  for (const node of nodes) {
    const next = offset + node.length;
    if (next > start && offset < end) {
      const change = node.parentElement.closest('[data-change-id]');
      if (change) changeIds.add(change.dataset.changeId);
    }
    offset = next;
  }
  return {
    anchor: block.dataset.anchor, start, end, quote, paragraph,
    changeId: changeIds.size === 1 ? [...changeIds][0] : null,
  };
}

export function resolveRange(root, annotation) {
  if (annotation.parts) {
    const blocks = new Map();
    for (const block of root.querySelectorAll(blockSelector)) {
      if (block.getClientRects().length) {
        const key = block.dataset.anchor;
        blocks.set(key, blocks.has(key) ? null : block);
      }
    }
    let combined;
    for (const part of annotation.parts) {
      const block = blocks.get(part.anchor);
      const segment = block && rangeInBlock(block, part);
      if (!segment || (combined && combined.comparePoint(segment.startContainer, segment.startOffset) !== 1)) return null;
      if (!combined) combined = segment;
      else combined.setEnd(segment.endContainer, segment.endOffset);
    }
    return combined ?? null;
  }
  const matches = [...root.querySelectorAll(blockSelector)].filter((block) =>
    block.dataset.anchor === annotation.anchor && block.getClientRects().length);
  if (matches.length !== 1) return null;
  return rangeInBlock(matches[0], annotation);
}

function rangeInBlock(block, annotation) {
  let nodes = textNodes(block);
  if (annotation.paragraph.includes('¶') && nodes.map((node) => node.data).join('') !== annotation.paragraph) {
    nodes = textNodes(block, true);
  }
  const text = nodes.map((node) => node.data).join('');
  if (text !== annotation.paragraph || text.slice(annotation.start, annotation.end) !== annotation.quote) return null;
  let offset = 0;
  const range = document.createRange();
  let started = false;
  for (const node of nodes) {
    const next = offset + node.length;
    if (!started && annotation.start < next) {
      range.setStart(node, annotation.start - offset);
      started = true;
    }
    if (started && annotation.end <= next) {
      range.setEnd(node, annotation.end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}
