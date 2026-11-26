// Search the text visible on each side, then intersect quote ranges with engine change IDs.
// Positions use UTF-16 offsets, like DOM Range and the persisted annotation anchors.
const exact = (s) => s;
const folded = (s) => s.replace(/\s/gu, '').replace(/[！-～]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'").replace(/。/gu, '.');
const loose = (s) => folded(s).replace(/[，,。.“”"'、！？!?；;：:（）()]/gu, '');
const unquote = (s) => (s || '').trim().replace(/^(?:“([\s\S]*)”|「([\s\S]*)」|『([\s\S]*)』|"([\s\S]*)")$/u,
  (_, ...groups) => groups.slice(0,4).find((group) => group !== undefined));
const modes = [exact, folded, loose];
const maximumHits = 80;
const nonempty = (s) => s?.replace(/[¶\s]/gu, '');
const rawEdit = (change, side) => side === 'left' ? change.moveEdit?.from ?? change.removedText : change.moveEdit?.to ?? change.addedText;

// Legacy integrations may supply only engine hunk text and paragraph positions.
function fromChanges(changes, side) {
  const blocks = new Map();
  for (const change of changes) {
    const entry = change[side];
    if (!entry) continue;
    const key = entry.anchor ?? [entry.section, entry.number, entry.text].join('\n');
    if (!blocks.has(key)) blocks.set(key, { entry, spans: [] });
    const edit = (rawEdit(change, side) || '').replace(/¶/gu, '');
    if (!edit) continue;
    const start = entry.text.indexOf(edit);
    if (start >= 0 && entry.text.indexOf(edit, start + 1) < 0) {
      blocks.get(key).spans.push({ id: change.id, start, end: start + edit.length });
    }
  }
  return { entries: [...blocks.values()].map((b) => b.entry), spansByEntry: [...blocks.values()].map((b) => b.spans) };
}

function searchIndex(data, normalize) {
  let text = '';
  const spans = [];
  const paragraphs = [];
  for (const [i, entry] of data.entries.entries()) {
    if (i) text += normalize('\n');
    const offset = text.length;
    text += normalize(entry.text);
    paragraphs.push({ start: offset, end: text.length, entry });
    for (const s of data.spansByEntry[i]) {
      const start = offset + normalize(entry.text.slice(0, s.start)).length;
      spans.push({ id: s.id, start, end: start + normalize(entry.text.slice(s.start, s.end)).length });
    }
  }
  spans.sort((a,b) => a.start - b.start || a.end - b.end);
  const bounds = new Map();
  for (const span of spans) {
    const prior = bounds.get(span.id);
    bounds.set(span.id,{ start: prior?.start ?? span.start, end: Math.max(prior?.end ?? 0,span.end) });
  }
  return { text, spans, bounds, paragraphs };
}

function firstAt(array, predicate) {
  let lo = 0, hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (predicate(array[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function occurrences(index, quote) {
  const hits = [];
  if (!quote) return hits;
  for (let start = index.text.indexOf(quote); start >= 0; start = index.text.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    const ids = new Set();
    for (let i = firstAt(index.spans, (s) => s.end >= start); i < index.spans.length; i++) {
      const span = index.spans[i];
      if (span.start >= end) break;
      if (span.end > start) ids.add(span.id);
    }
    const first = firstAt(index.paragraphs, (p) => p.end > start);
    const last = firstAt(index.paragraphs, (p) => p.end >= end);
    const complete = [...ids].every((id) => {
      const range = index.bounds.get(id);
      return range.start >= start && range.end <= end;
    });
    hits.push({ ids, complete, start, end, first, last, entries: index.paragraphs.slice(first, last + 1).map((p) => p.entry) });
    if (hits.length > maximumHits) break;
  }
  return hits;
}

function locationFits(hint, entry) {
  if (!hint || !entry) return false;
  const location = folded(hint);
  const paragraph = /第?(\d+)个?(?:段落|段)/u.exec(location);
  const chapter = /第[零〇一二三四五六七八九十百\d]+[章节]/u.exec(location);
  if (paragraph && entry.number !== Number(paragraph[1])) return false;
  const section = folded(entry.section || '');
  if (chapter) return section.includes(chapter[0]);
  const rest = (paragraph ? location.replace(paragraph[0], '') : location).replace(/^[/，,、·]+|[/，,、·]+$/gu,'');
  return rest ? section.split('/').some((s) => s && (s.includes(rest) || rest.includes(s))) : Boolean(paragraph);
}

function hasAdjacentContext(index, hit, matchesContext) {
  if (!hit) return false;
  const before = index.paragraphs[hit.first - 1]?.entry;
  const after = index.paragraphs[hit.last + 1]?.entry;
  return (before && before.section === hit.entries[0].section && matchesContext(before)) ||
    (after && after.section === hit.entries.at(-1).section && matchesContext(after));
}

function analyse(note, views, changes, byId) {
  const before = unquote(note.before), after = unquote(note.after);
  const context = folded(unquote(note.context));
  const matchesContext = (entry) => folded(entry.text).includes(context);
  const matchesLocation = (entries) => !note.location || entries.some((entry) => locationFits(note.location,entry));
  const hints = Boolean(note.location || context);
  const partial = new Set();
  let many = false;
  for (const [level, normalize] of modes.entries()) {
    const [left, right] = views[level];
    const a = occurrences(left,normalize(before)), b = occurrences(right,normalize(after));
    if (a.length > maximumHits || b.length > maximumHits) { many = true; break; }
    const candidates = new Map();
    const declared = { '新增':'inserted', '插入':'inserted', '删除':'deleted', '替换':'replaced', '格式':'formatting',
      '拆分':'paragraph', '合并':'paragraph', insertion:'inserted', deletion:'deleted', replacement:'replaced' }[note.type?.trim().toLowerCase()];
    const remember = (ids, leftHit, rightHit, strong) => {
      const leftEntries = leftHit?.entries ?? [];
      const rightEntries = rightHit?.entries ?? [];
      const entries = [...leftEntries,...rightEntries];
      const ordered = [...ids].filter((id) => byId.has(id)).sort((x,y) => byId.get(x).i - byId.get(y).i);
      if (!ordered.length) return;
      const locationMatch = matchesLocation(entries);
      // Only context within a paragraph touched by the quote can identify the candidate.
      const localContext = Boolean(context && entries.some(matchesContext));
      const adjacentContext = Boolean(context && !localContext &&
        (hasAdjacentContext(left,leftHit,matchesContext) || hasAdjacentContext(right,rightHit,matchesContext)));
      const located = locationMatch && (!context || localContext);
      const key = JSON.stringify(ordered);
      if (declared && !ordered.some((id) => byId.get(id).change.kind === declared)) strong = false;
      const existing = candidates.get(key);
      const candidate = { ids: ordered, supported: strong && located && level < 2, located,
        locationMatch, localContext, adjacentContext, leftEntries, rightEntries };
      if (!existing || (located && !existing.located) || (candidate.supported && !existing.supported)) candidates.set(key, candidate);
    };
    for (const hit of [...a,...b]) for (const id of hit.ids) partial.add(id);
    if (before && after) {
      for (const l of a) for (const r of b) {
        const ids = new Set([...l.ids,...r.ids].filter((id) => byId.has(id)));
        if (!ids.size) continue;
        const common = [...l.ids].some((id) => r.ids.has(id));
        const structure = [...ids].some((id) => byId.get(id).change.kind === 'paragraph') && l.last-l.first !== r.last-r.first;
        const sameBlock = l.entries.some((p) => p.anchor && r.entries.some((q) => q.anchor === p.anchor));
        // Separate insertion/deletion paragraphs must share unchanged bounding paragraphs on BOTH sides.
        const leftFlanks = [left.paragraphs[l.first-1],left.paragraphs[l.last+1]];
        const rightFlanks = [right.paragraphs[r.first-1],right.paragraphs[r.last+1]];
        const flanked = leftFlanks.every((p,i) => p?.entry.anchor && p.entry.anchor === rightFlanks[i]?.entry.anchor);
        if (!common && !sameBlock && !flanked) continue;
        const supported = [...ids].every((id) => {
          const c = byId.get(id).change;
          return c.kind === 'paragraph' ? structure : c.kind !== 'formatting' &&
            (!nonempty(rawEdit(c,'left')) || l.ids.has(id)) && (!nonempty(rawEdit(c,'right')) || r.ids.has(id));
        });
        const orders = [...ids].map((id) => byId.get(id).i);
        const continuous = Math.max(...orders)-Math.min(...orders)+1 === ids.size;
        // A boundary in a different passage cannot establish correspondence.
        const hinted = note.type || note.title || note.reason || '';
        const quoteDelta = after.split('\n').length - before.split('\n').length;
        const actualDelta = (r.last-r.first) - (l.last-l.first);
        const direction = /拆分|分段|split/iu.test(hinted) ? 1 : /合并|并段|merge/iu.test(hinted) ? -1 : 0;
        const alignedBoundary = structure && (direction || quoteDelta) &&
          (!direction || Math.sign(actualDelta) === direction) && (!quoteDelta || Math.sign(actualDelta) === Math.sign(quoteDelta));
        // Disjoint changes within one paragraph also need matching text immediately around the quotes.
        const surrounds = (index,hit) => [
          index.text.slice(Math.max(index.paragraphs[hit.first].start,hit.start-16),hit.start),
          index.text.slice(hit.end,Math.min(index.paragraphs[hit.last].end,hit.end+16)),
        ];
        const nearby = sameBlock && surrounds(left,l).every((v,i) => v === surrounds(right,r)[i]);
        const twoMarkedSides = l.ids.size > 0 && r.ids.size > 0;
        const eligible = supported && continuous && l.complete && r.complete && (twoMarkedSides || alignedBoundary) &&
          (common || nearby || flanked || alignedBoundary) && (!structure || alignedBoundary) &&
          (normalize(before) !== normalize(after) || alignedBoundary);
        remember(ids,l,r,eligible);
      }
    } else if (before || after) {
      const insertion = !before;
      for (const hit of insertion ? b : a) {
        const ids = [...hit.ids].filter((id) => byId.has(id));
        const typeFits = ids.length && ids.every((id) => byId.get(id).change.kind === (insertion ? 'inserted' : 'deleted'));
        const explicit = (insertion ? note.emptyBefore : note.emptyAfter) || declared === (insertion ? 'inserted' : 'deleted');
        const quote = normalize(before || after);
        const entire = ids.length === 1 && normalize((rawEdit(byId.get(ids[0]).change,insertion?'right':'left') || '').replace(/¶/gu,'')).trim() === quote;
        remember(ids,insertion ? null : hit,insertion ? hit : null,typeFits && (explicit || hints) && entire && quote.length >= 4);
      }
    }
    if (!candidates.size) continue;
    const all = [...candidates.values()];
    const located = hints ? all.filter((c) => c.located) : all;
    const pool = located.length ? located : all;
    const unique = pool.length === 1 && pool[0].supported;
    const evidence = [level === 0 ? '引文按原字符命中。' : level === 1 ? '统一全半角字符（含数字），忽略空白和换行后命中。' : '仅在省略部分标点后命中，需核实语义。'];
    evidence.push(before && after ? '已核对两侧引文覆盖的修改标记。' : '仅一侧提供引文。');
    if (note.location) evidence.push(pool.some((c) => c.locationMatch) ? '章节或段落位置线索吻合。' : '章节或段落位置未能核实。');
    if (context) {
      if (pool.some((c) => c.localContext)) evidence.push('引文所在段落包含给出的前后文。');
      else if (pool.some((c) => c.adjacentContext)) evidence.push('前后文仅出现在同章节的相邻段落，需人工核实。');
      else evidence.push('引文所在段落及同章节的相邻段落均未验证前后文。');
    }
    if (pool.length > 1) evidence.push('有多组修改位置符合引文，需人工区分。');
    else if (unique) evidence.push('修改类型与引文一致，只有一组符合条件的位置。');
    else evidence.push('现有证据不足以确认整条记录。');
    const passages = Object.fromEntries(pool.map((c) => [JSON.stringify(c.ids), { left:c.leftEntries, right:c.rightEntries }]));
    return { passages, confidence: unique ? 'high' : 'medium', ids: unique ? pool[0].ids : [], candidates: pool.map((c) => c.ids), evidence, ambiguous: pool.length > 1 };
  }
  const weak = changes.filter((c) => {
    if (partial.has(c.id)) return true;
    const entries = [c.left,c.right].filter(Boolean);
    return hints && matchesLocation(entries) && (!context || entries.some(matchesContext));
  });
  if (weak.length || many) {
    return { confidence: partial.size && !many ? 'medium' : 'low', ids: [], candidates: weak.map((c) => [c.id]), ambiguous: many || weak.length > 1,
      evidence: [many ? '引文重复过多，无法可靠区分位置。' : partial.size ? '只有部分引文命中修改，不能验证另一侧或对应关系。' : '仅位置线索吻合，缺少修改引文。'] };
  }
  // Similar wording can suggest a place to inspect, but never creates a link.
  const trigrams = (text) => new Set(Array.from({ length: Math.max(0,text.length-2) },(_,i) => text.slice(i,i+3)));
  const quotes = [before,after].map((q) => loose(q)).map((q) => q.length >= 6 ? trigrams(q) : null);
  const similar = changes.filter((c) => [c.left,c.right].some((p,i) => {
    if (!p || !quotes[i]) return false;
    const text = loose(p.text);
    if (text.length < 6) return false;
    let hits = 0;
    for (const gram of quotes[i]) if (text.includes(gram)) hits++;
    return hits >= 4 && hits >= quotes[i].size * 0.65;
  }));
  if (similar.length) return { confidence: 'low', ids: [], candidates: similar.map((c) => [c.id]), ambiguous: similar.length > 1,
    evidence: ['段落包含部分相似措辞，完整引文未能验证。'] };
  return { confidence: 'none', ids: [], candidates: [], ambiguous: false,
    evidence: [before || after ? '未找到可核实的对应修改标记。' : '未提取到引文或可核实的位置线索。'] };
}

export function assessNotes(records, changes, positions) {
  if (!records.length) return {};
  const sides = ['left','right'].map((side) => positions?.[side] ?? fromChanges(changes,side));
  const views = modes.map((normalize) => sides.map((side) => searchIndex(side,normalize)));
  const byId = new Map(changes.map((change,i) => [change.id,{ change,i }]));
  const numbers = new Map(), quotes = new Map();
  const quoteKey = (n) => JSON.stringify([folded(n.before),folded(n.after)]);
  for (const n of records) {
    if (n.number) numbers.set(n.number,(numbers.get(n.number) || 0)+1);
    if (n.before || n.after) quotes.set(quoteKey(n),(quotes.get(quoteKey(n)) || 0)+1);
  }
  return Object.fromEntries(records.map((note) => {
    const result = analyse(note,views,changes,byId);
    const warnings = [];
    if (note.warning) warnings.push(note.warning);
    if (!note.before && !note.emptyBefore) warnings.push('缺少原文引文');
    if (!note.after && !note.emptyAfter) warnings.push('缺少二校引文');
    if (numbers.get(note.number)>1) warnings.push('记录编号重复');
    if (quotes.get(quoteKey(note))>1) warnings.push('引文组合重复');
    if (result.ambiguous) warnings.push('位置存在歧义');
    return [note.id,{ ...result,warnings }];
  }));
}

export function suggestLinks(records, changes) {
  return Object.fromEntries(Object.entries(assessNotes(records, changes)).filter(([,r]) => r.ids.length).map(([id,r]) => [id,r.ids[0]]));
}

