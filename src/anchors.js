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
  const block = blockOf(position.startContainer);
  if (!block || block !== blockOf(position.endContainer)) return null;
  const range = document.createRange();
  range.setStart(position.startContainer, position.startOffset);
  range.setEnd(position.endContainer, position.endOffset);
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
    anchor: block.dataset.anchor, side, start, end, quote, paragraph,
    changeId: changeIds.size === 1 ? [...changeIds][0] : null,
    rect: range.getBoundingClientRect(),
  };
}

export function resolveRange(root, annotation) {
  const matches = [...root.querySelectorAll(blockSelector)].filter((block) =>
    block.dataset.anchor === annotation.anchor && block.getClientRects().length);
  if (matches.length !== 1) return null;
  let nodes = textNodes(matches[0]);
  if (annotation.paragraph.includes('¶') && nodes.map((node) => node.data).join('') !== annotation.paragraph) {
    nodes = textNodes(matches[0], true);
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
