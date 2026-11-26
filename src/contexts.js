import { readBlock, resolveRange } from './anchors';

export function indexPositions(root) {
  const positions = new Map();
  const entries = [];
  const tables = [...root.querySelectorAll('table')].filter((element) => element.getClientRects().length);
  const headings = [];
  const spansByEntry = [];
  let number = 0;
  for (const block of root.querySelectorAll('[data-anchor]')) {
    if (!block.getClientRects().length || !block.matches('p,h1,h2,h3,h4,h5,h6,li,div')) continue;
    const { text, spans } = readBlock(block);
    spansByEntry.push(spans);
    const level = /^H([1-6])$/.exec(block.tagName);
    const note = block.closest('li[id^="fn-"],li[id^="en-"]')?.id;
    if (level && !note) {
      while (headings.length && headings.at(-1).level >= Number(level[1])) headings.pop();
      headings.push({ level: Number(level[1]), text });
    }
    const cell = block.closest('td,th');
    const table = cell?.closest('table');
    const row = cell?.parentElement;
    const visible = (element) => element.getClientRects().length;
    const entry = { anchor: block.dataset.anchor, text, section: headings.map((item) => item.text).filter(Boolean).join(' / '),
      number: note ? null : ++number, note: note || '', heading: Boolean(level),
      table: table ? tables.indexOf(table) + 1 : null, row: table ? [...table.rows].filter(visible).indexOf(row) + 1 : null,
      cell: row ? [...row.cells].filter(visible).indexOf(cell) + 1 : null };
    entries.push(entry);
    // An ambiguous engine anchor must never be used as an exact position.
    positions.set(entry.anchor, positions.has(entry.anchor) ? null : entry);
  }
  return { positions, entries, spansByEntry };
}

export function positionLabel(position) {
  if (!position) return '无对应段落';
  const parts = [];
  if (position.section) parts.push(position.section);
  if (position.note) parts.push((position.note.startsWith('fn-') ? '脚注 ' : '尾注 ') + position.note.slice(3));
  if (position.number !== null) parts.push('第 ' + position.number + ' 段');
  if (position.table) parts.push('表 ' + position.table + ' · 第 ' + position.row + ' 行第 ' + position.cell + ' 单元格');
  return parts.join(' / ') || '文档正文';
}

export function locateChange(change, positionsBySide) {
  const first = (side) => change.anchors.map((anchor) => positionsBySide[side].positions.get(anchor)).find(Boolean) ?? null;
  return { ...change, left: first('left'), right: first('right') };
}

export function annotationEvidence(anchor, changes, positionsBySide) {
  if (anchor.parts?.length) {
    const parts = anchor.parts.map((part) => annotationEvidence({ ...part, side: anchor.side }, changes, positionsBySide));
    const evidence = { position: parts[0].position, endPosition: parts.at(-1).position };
    for (const side of ['left', 'right']) {
      const entries = [...new Set(parts.map((part) => part[side]).filter(Boolean))];
      evidence[side] = entries.length ? { ...entries[0], text: entries.map((entry) => entry.text).join('\n') } : null;
    }
    return evidence;
  }
  const other = anchor.side === 'left' ? 'right' : 'left';
  const own = positionsBySide[anchor.side].positions.get(anchor.anchor);
  const paired = positionsBySide[other].positions.get(anchor.anchor);
  const change = changes.find((item) => item.id === anchor.changeId);
  return {
    position: own ?? null,
    left: anchor.side === 'left' ? own : paired ?? change?.left ?? null,
    right: anchor.side === 'right' ? own : paired ?? change?.right ?? null,
  };
}

export function carryAnnotation(annotation, sourceRound, newRound, rightIndex, rightRoot) {
  const origin = { roundId: sourceRound.id, annotationId: annotation.id, number: annotation.number };
  const prior = { ...annotation, id: crypto.randomUUID(), origin, changeId: null, changeIds: undefined,
    status: 'pending', createdAt: annotation.createdAt, needsLocation: true };
  if (annotation.needsLocation) return prior;
  if (annotation.parts?.length) {
    const parts = annotation.parts;
    const starts = rightIndex.entries.map((entry, i) => i).filter((i) =>
      parts.every((part, j) => rightIndex.entries[i + j]?.text === part.paragraph) &&
      (!annotation.evidence?.position?.section || rightIndex.entries[i].section === annotation.evidence.position.section));
    if (starts.length !== 1) return prior;
    const start = starts[0];
    const changeIds = new Set();
    const nextParts = parts.map((part, j) => {
      const ids = rightIndex.spansByEntry[start + j].filter((span) => span.start < part.end && span.end > part.start);
      for (const span of ids) changeIds.add(span.id);
      return { ...part, anchor: rightIndex.entries[start + j].anchor, changeId: null };
    });
    const proposed = { ...prior, anchor: nextParts[0].anchor, parts: nextParts, changeIds: [...changeIds],
      side: 'right', fileHash: newRound.revised.hash, needsLocation: false };
    return resolveRange(rightRoot, proposed) ? proposed : prior;
  }
  const paragraph = annotation.paragraph;
  const candidates = rightIndex.entries.filter((entry) => entry.text === paragraph);
  if (candidates.length !== 1) return prior;
  const hit = candidates[0];
  if (annotation.evidence?.position?.section && hit.section !== annotation.evidence.position.section) return prior;
  const proposed = { ...prior, anchor: hit.anchor, side: 'right', fileHash: newRound.revised.hash, needsLocation: false };
  return resolveRange(rightRoot, proposed) ? proposed : prior;
}
