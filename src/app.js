import DOMPurify from 'dompurify';
import { buildChangeItems } from './upstream/model/changes';
import { buildDocIndex } from './upstream/model/docIndex';
import { markCommon, mergeJoinedParagraphs, prepareRenderedDocument } from './upstream/ui/renderedDocument';
import { captureAnchor, resolveRange } from './anchors';
import { mapScrollTop, measureBlocks, pairOffsets } from './upstream/ui/scrollMapping';
import { annotationEvidence, carryAnnotation, indexPositions, locateChange, positionLabel } from './contexts';
import { noteDocumentText, parseNotes, assessNotes } from './notes.mjs';
import { makeFeedback } from './feedback.mjs';
import {
  createProject, exportProject, getActive, getFile, getLegacy, getProject, listProjects, restoreProject,
  saveNewProject, saveRound, setActive, stageFile, wasMigrated,
} from './storage';
import panelCss from './panel.css?inline';
import './style.css';

const byId = (id) => document.getElementById(id);
const kinds = {
  inserted: '新增', deleted: '删除', replaced: '替换',
  formatting: '格式', moved: '移动', paragraph: '段落拆分或合并',
};
const sides = { left: '原文', right: '二校稿' };
const panels = Object.entries(sides).map(([side, label]) => {
  const host = byId(side);
  return { side, label, host, root: host.attachShadow({ mode: 'open' }) };
});
const dialog = byId('comment-dialog');
const selectionCard = byId('selection-card');
const selectionButton = byId('annotate');
const newEngine = () => new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
let engine = newEngine();
const appBaseUrl = new URL(import.meta.env.BASE_URL, location.href).href;
engine.postMessage({ appBaseUrl });
let current = null;
let project = null;
let importMode = 'project';
let changes = [];
let positionsBySide = {};
let records = [];
let assessments = {};
let index = -1;
let selection = null;
let selectionPin = null;
let placementFrame = 0;
let editing = null;
let running = false;
let saving = false;
let reanchoring = null;
let placed = [];
let anchorPairs = new Map();
const scrollExpected = new WeakMap();

function status(message, error = false) {
  byId('status').textContent = message;
  byId('status').classList.toggle('error', error);
}

function dom(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, handler) {
  const button = dom('button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function sanitizedDocument(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  DOMPurify.sanitize(parsed.body, {
    IN_PLACE: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['href', 'srcset', 'action', 'formaction', 'target', 'ping'],
  });
  for (const image of parsed.body.querySelectorAll('img[src]')) {
    if (!/^data:image\/(png|jpeg|gif|webp|bmp|tiff);base64,/i.test(image.getAttribute('src'))) {
      image.removeAttribute('src');
    }
  }
  return parsed;
}

function mountDocument(panel, source) {
  const sheet = dom('div', undefined, 'doc');
  sheet.dataset.side = panel.side;
  sheet.append(...[...source.body.childNodes].map((node) => node.cloneNode(true)));
  mergeJoinedParagraphs(sheet, panel.side);
  markCommon(sheet, { ignoreQuotes: false, ignoreDashes: false, ignoreWhitespace: false });
  const styles = dom('style', source.css + '\n' + panelCss);
  panel.root.replaceChildren(styles, sheet);
  panel.observer?.disconnect();
  panel.observer = new ResizeObserver(() => anchorPairs.clear());
  panel.observer.observe(sheet);
}

function renderChanges() {
  byId('prev').disabled = index <= 0;
  byId('next').disabled = index < 0 || index >= changes.length - 1;
  byId('jump').disabled = changes.length === 0;
  const select = byId('jump');
  select.replaceChildren();
  if (!changes.length) select.append(new Option('暂无修改'));
  changes.forEach((item, number) => {
    const summary = (item.addedText || item.removedText || item.text || '').replace(/\s+/g, ' ').slice(0, 38);
    select.append(new Option(`${number + 1} / ${changes.length} · ${kinds[item.kind]} ${summary}`, String(number)));
  });
  select.value = index < 0 ? '暂无修改' : String(index);
}

function visibleMatch(root, attribute, value) {
  return [...root.querySelectorAll(`[${attribute}="${CSS.escape(value)}"]`)]
    .find((element) => element.getClientRects().length);
}

function scrollTo(panel, top) {
  const clamped = Math.round(Math.max(0, Math.min(top, panel.host.scrollHeight - panel.host.clientHeight)));
  if (Math.abs(panel.host.scrollTop - clamped) < 1) return;
  scrollExpected.set(panel.host, clamped);
  panel.host.scrollTop = clamped;
}

function reveal(panel, rect) {
  const scroller = panel.host;
  scrollTo(panel, scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top - scroller.clientHeight * .25);
}

const confidenceLabel = { high: '高可信度', medium: '中可信度', low: '低可信度', none: '未匹配' };

function effectiveLink(id, result, overrides, items) {
  const manual = Object.hasOwn(overrides, id);
  const value = manual ? overrides[id] : result.ids;
  const ids = (Array.isArray(value) ? value : [value]).filter((v) => v && items.some((c) => c.id === v));
  return { ids, id: ids[0], label: ids.length ? (manual ? '人工匹配' : '自动匹配') : '未匹配', manual };
}

function linkFor(note) {
  return effectiveLink(note.id, assessments[note.id], current.noteOverrides, changes);
}

function linkedNotes(changeId) {
  return changeId ? records.filter((note) => linkFor(note).ids.includes(changeId)) : [];
}

function closeSelectionCard() {
  selectionCard.hidden = true;
  selection = null;
  selectionPin = null;
  cancelAnimationFrame(placementFrame);
  placementFrame = 0;
}

function showSelectionCard(model, pin) {
  selection = model;
  selectionPin = pin;
  const side = positionsBySide[model.side];
  const targets = new Set();
  const anchors = new Set();
  for (const part of model.parts ?? [model]) {
    const position = side.positions.get(part.anchor);
    if (position) anchors.add(part.anchor);
    const spans = side.spansByEntry[side.entries.indexOf(position)] ?? [];
    for (const span of spans) if (span.start < part.end && span.end > part.start) targets.add(span.id);
    if (part.changeId) targets.add(part.changeId);
  }
  const paragraphScope = !targets.size && anchors.size > 0;
  if (paragraphScope) {
    for (const change of changes) if (change.anchors.some((anchor) => anchors.has(anchor))) targets.add(change.id);
  }
  if (model.parts) model.changeIds = [...targets];
  const notes = records.filter((note) => linkFor(note).ids.some((id) => targets.has(id)));
  const body = byId('selection-reasons');
  body.replaceChildren();
  byId('selection-title').textContent = model.parts ? `所选 ${model.parts.length} 段的修改理由`
    : paragraphScope && targets.size ? '本段修改理由' : '修改理由';
  for (const note of notes) {
    const section = dom('article');
    section.append(dom('p', note.reason || '该记录未提供修改理由。'));
    body.append(section);
  }
  if (!notes.length) body.append(dom('p', current.notes ? '此处没有已关联的修改说明。' : '本轮尚未导入修改说明。', 'muted'));
  body.scrollTop = 0;
  placeSelectionCard();
}

function scheduleSelectionPlacement() {
  if (!selectionPin || placementFrame) return;
  placementFrame = requestAnimationFrame(() => {
    placementFrame = 0;
    placeSelectionCard();
  });
}

function placeSelectionCard() {
  if (!selectionPin) return;
  const rect = selectionPin.getBoundingClientRect();
  const host = byId(selection.side).getBoundingClientRect();
  selectionCard.style.maxHeight = '';
  selectionCard.hidden = false;
  const gap = 8;
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const topEdge = Math.min(height, Math.max(0, host.top));
  const bottomEdge = Math.max(topEdge, Math.min(height, host.bottom));
  const top = Math.min(bottomEdge, Math.max(topEdge, rect.top));
  const bottom = Math.min(bottomEdge, Math.max(topEdge, rect.bottom));
  const below = height - bottom - 2 * gap;
  const above = top - 2 * gap;
  const card = selectionCard.getBoundingClientRect();
  const useBelow = card.height <= below || (above < card.height && below >= above);
  const available = useBelow ? below : above;
  // A selection taller than the viewport can leave neither side usable.
  if (available < card.height && available >= 128) selectionCard.style.maxHeight = available + 'px';
  const h = selectionCard.offsetHeight;
  selectionCard.style.left = Math.max(gap, Math.min(rect.left, width - card.width - gap)) + 'px';
  selectionCard.style.top = Math.max(gap, Math.min(useBelow ? bottom + gap : top - h - gap, height - h - gap)) + 'px';
}

function noteTitle(note, i) {
  return [note.number ? '记录 ' + note.number : '说明 ' + (i + 1), note.title].filter(Boolean).join(' · ');
}

function showEvidence(note, result, items, link, interactive) {
  const detail = dom('details', undefined, 'match-evidence');
  detail.append(dom('summary', '匹配依据与对应正文'));
  detail.addEventListener('toggle', () => {
    if (!detail.open || detail.children.length > 1) return;
    detail.append(dom('p', result.evidence.join(' ')));
    if (link.manual) detail.append(dom('p', link.id ? '当前关联由人工指定。' : '此记录的关联已由人工解除。'));
    const groups = [...result.candidates];
    if (link.ids.length && !groups.some((g) => g.join() === link.ids.join())) groups.unshift(link.ids);
    for (const group of groups) {
      const box = dom('section', undefined, 'candidate-group');
      const passage = result.passages?.[JSON.stringify(group)];
      if (passage) {
        for (const [side,label] of Object.entries(sides)) {
          for (const entry of passage[side]) box.append(dom('small',label + ' · ' + positionLabel(entry),'block-meta'),
            dom('div',entry.text,'change-text'));
        }
      }
      for (const id of group) {
        const i = items.findIndex((c) => c.id === id);
        if (i < 0) continue;
        const c = items[i];
        box.append(dom('strong', '修改 ' + (i+1) + ' · ' + kinds[c.kind]));
        for (const [side,label] of Object.entries(sides)) {
          if (passage?.[side].length) continue;
          const pos = c[side];
          const edit = side === 'left' ? c.moveEdit?.from ?? c.removedText : c.moveEdit?.to ?? c.addedText;
          box.append(dom('small', label + ' · ' + positionLabel(pos), 'block-meta'),
            dom('div', pos?.text || edit || '（此侧无对应文字）', 'change-text'));
        }
        if (interactive) box.append(action('查看修改 ' + (i+1), () => go(i)));
      }
      if (interactive && group.length && (!link.id || group.join() !== link.ids.join())) {
        box.append(action('确认此候选位置', () => changeLink(note.id, group)));
      }
      detail.append(box);
    }
    detail.append(dom('small', '说明文件原始记录', 'block-meta'), dom('div', note.raw, 'change-text'));
  });
  return detail;
}

function recordIssues(result) {
  return dom('small', result.warnings.join(' · '), 'match-issues');
}

function previewNotes(notes, results, items, overrides = {}) {
  const preview = byId('notes-preview');
  const list = byId('preview-records');
  list.replaceChildren();
  let linked = 0, review = 0;
  notes.forEach((note,i) => {
    const result = results[note.id];
    const link = effectiveLink(note.id,result,overrides,items);
    if (link.id) linked++;
    else if (result.candidates.length || result.ambiguous) review++;
    const row = dom('article', undefined, 'preview-note');
    row.dataset.confidence = result.confidence;
    row.dataset.targets = link.ids.map((id) => items.findIndex((c) => c.id === id) + 1).join(',');
    row.append(dom('strong', noteTitle(note,i)), dom('span',confidenceLabel[result.confidence], 'badge'),
      dom('small', link.id ? link.label + ' · 修改 ' + row.dataset.targets : '尚未关联', 'block-meta'));
    if (note.location || note.context) row.append(dom('small',[note.location,note.context].filter(Boolean).join(' · '),'block-meta'));
    if (note.before || note.after) row.append(dom('div','原文　' + (note.before || '—'),'change-text before'),
      dom('div','二校　' + (note.after || '—'),'change-text after'));
    row.append(dom('div',note.reason || note.raw,'change-text'), recordIssues(result), showEvidence(note,result,items,link,false));
    list.append(row);
  });
  byId('preview-summary').textContent = '识别 ' + notes.length + ' 条 · 已匹配 ' + linked + ' · 待人工确认 ' + review + ' · 未匹配 ' + (notes.length-linked-review);
  preview.returnValue = '';
  return new Promise((resolve) => {
    preview.addEventListener('close', () => resolve(preview.returnValue === 'apply'), { once: true });
    preview.showModal();
  });
}
byId('preview-apply').onclick = () => byId('notes-preview').close('apply');
byId('preview-cancel').onclick = () => byId('notes-preview').close('cancel');

function reasonFor(annotation) {
  const related = annotation.changeIds?.length
    ? records.filter((note) => linkFor(note).ids.some((id) => annotation.changeIds.includes(id)))
    : linkedNotes(annotation.changeId);
  return related.filter((note) => note.reason)
    .map((note) => (note.number ? '记录 ' + note.number + ' · ' : '') + note.reason).join('\n');
}

function annotationFileName(annotation, located) {
  const currentFile = annotation.side === 'left' ? current.base : current.revised;
  if (located || !annotation.fileHash || currentFile.hash === annotation.fileHash) return currentFile.name;
  return [project.original, ...project.rounds.flatMap((round) => [round.base, round.revised])]
    .find((ref) => ref.hash === annotation.fileHash)?.name ?? '历史文档';
}

function annotationLocation(evidence) {
  if (!evidence?.position) return '位置待核对';
  const start = positionLabel(evidence.position);
  return evidence.endPosition ? start + ' 至 ' + positionLabel(evidence.endPosition) : start;
}

function updateProjectSummary() {
  const number = project && current ? project.rounds.findIndex((item) => item.id === current.id) + 1 : 0;
  byId('project-summary').textContent = number
    ? `${project.name} · 第 ${number} / ${project.rounds.length} 轮 · ${changes.length} 处修改 · ${current.annotations.length} 条批注`
    : '在本机导入文件，开始校对';
  byId('history').disabled = !project || running || saving;
  byId('feedback').disabled = !current || running || saving;
  byId('new-round').disabled = !project || running || saving;
  byId('new-project').disabled = running || saving;
  byId('project-select').disabled = running || saving;
  byId('compare').disabled = running || saving;
}

function renderNotes() {
  const list = byId('note-list');
  list.replaceChildren();
  const filter = byId('note-filter').value;
  byId('note-filter').disabled = !records.length;
  byId('notes-update').disabled = !current;
  byId('notes-update').textContent = current?.notes ? '替换本轮说明' : '导入本轮说明';
  const matched = records.filter((note) => linkFor(note).id).length;
  const summary = byId('notes-details').querySelector('summary');
  if (!current) return;
  summary.textContent = current.notes
    ? `修改说明 · ${matched} 已匹配 / ${records.length - matched} 未匹配` : '修改说明 · 尚未导入';
  const visible = records.filter((note) => {
    if (filter === 'all') return true;
    const linked = Boolean(linkFor(note).id);
    if (filter === 'review') return !linked && ['medium','low'].includes(assessments[note.id].confidence);
    return linked === (filter === 'linked');
  });
  if (!visible.length) list.textContent = records.length ? '此筛选条件下没有记录。' : '没有可供匹配的修改说明记录。';
  for (const note of visible) {
    const link = linkFor(note);
    const result = assessments[note.id];
    const row = dom('article', undefined, 'item note-item');
    row.append(dom('strong', noteTitle(note, records.indexOf(note))),
      dom('span', link.label + (result.confidence === 'none' ? '' : ' · ' + confidenceLabel[result.confidence]), 'badge' + (link.id ? ' linked' : '')));
    if (note.location) row.append(dom('small', note.location, 'block-meta'));
    if (note.before) row.append(dom('div', note.before, 'change-text before'));
    if (note.after) row.append(dom('div', note.after, 'change-text after'));
    if (note.reason) row.append(dom('div', note.reason, 'change-text'));
    if (!note.before && !note.after && !note.reason) row.append(dom('p', note.raw, 'change-text'));
    row.append(recordIssues(result), showEvidence(note,result,changes,link,true));
    for (const id of link.ids) {
      const n = changes.findIndex((c) => c.id === id);
      row.append(action('定位修改 ' + (n+1), () => go(n)));
    }
    if (link.id) row.append(action('解除关联', () => changeLink(note.id, null)));
    if (changes[index] && !link.ids.includes(changes[index].id)) {
      row.append(action('关联到当前修改 ' + (index + 1), () => changeLink(note.id, changes[index].id)));
      if (link.id) row.append(action('追加当前修改', () => changeLink(note.id,[...link.ids,changes[index].id])));
    }
    list.append(row);
  }
}

async function changeLink(noteId, changeId) {
  if (await persistRound({ noteOverrides: { ...current.noteOverrides, [noteId]: changeId } },
    changeId ? '已保存人工关联' : '已解除关联')) {
    paintAnnotations();
    if (index >= 0) go(index, false);
    else renderNotes();
  }
}

function go(number, locate = true) {
  if (!changes[number]) return;
  index = number;
  const item = changes[index];
  const detail = byId('change');
  detail.replaceChildren(dom('strong', `${number + 1} / ${changes.length} · ${kinds[item.kind]}`));
  const before = item.moveEdit?.from ?? item.removedText;
  const after = item.moveEdit?.to ?? item.addedText;
  if (before) detail.append(dom('div', before, 'change-text before'));
  if (after) detail.append(dom('div', after, 'change-text after'));
  if (!before && !after && item.text) detail.append(dom('div', item.text, 'change-text'));
  if (item.description) detail.append(dom('p', item.description));
  if (item.left) detail.append(dom('small', '基准稿 · ' + positionLabel(item.left), 'block-meta'));
  if (item.right) detail.append(dom('small', '二校稿 · ' + positionLabel(item.right), 'block-meta'));
  const related = linkedNotes(item.id);
  detail.append(dom('h3', 'Codex 修改原因'));
  if (!related.length) {
    detail.append(dom('p', current.notes ? '未关联修改说明' : '本轮尚未导入修改说明', 'muted'));
  }
  for (const note of related) {
    detail.append(dom('small', (note.number ? '记录 ' + note.number + ' · ' : '') + linkFor(note).label, 'block-meta'),
      dom('p', note.reason || '该记录未提取到修改原因，可查看说明原文。', 'change-text'));
    detail.append(action('解除关联', () => changeLink(note.id, null)));
  }
  if (current.notes) detail.append(action('查看说明列表', () => {
    byId('notes-details').open = true;
    byId('notes-details').scrollIntoView({ block: 'nearest' });
  }));
  const linked = current.annotations.filter((note) => note.changeId === item.id || note.changeIds?.includes(item.id));
  for (const note of linked) detail.append(dom('p', note.comment, 'change-text'));
  for (const panel of panels) {
    for (const element of panel.root.querySelectorAll('.selected, .deletion-context')) {
      element.classList.remove('selected', 'deletion-context');
    }
    const hit = visibleMatch(panel.root, 'data-change-id', item.id);
    hit?.classList.add('selected');
    const target = hit ?? item.anchors.map((anchor) => visibleMatch(panel.root, 'data-anchor', anchor)).find(Boolean);
    if (panel.side === 'right' && item.kind === 'deleted' && !hit && target) {
      target.classList.add('deletion-context');
      detail.append(dom('small', '右栏虚线标出删除位置所在段落。', 'block-meta'));
    }
    if (locate && target) reveal(panel, target.getBoundingClientRect());
    if (locate && !target && byId('sync').checked) {
      const other = panels.find((entry) => entry !== panel);
      requestAnimationFrame(() => syncPanel(other, panel));
    }
  }
  byId('prev').disabled = index === 0;
  byId('next').disabled = index === changes.length - 1;
  byId('jump').value = String(index);
  renderNotes();
}

function syncPanel(from, to) {
  if (!anchorPairs.has(from.side)) {
    anchorPairs.set(from.side, pairOffsets(measureBlocks(from.host), measureBlocks(to.host)));
  }
  const top = mapScrollTop(anchorPairs.get(from.side), from.host.scrollTop);
  if (top !== null) scrollTo(to, top);
}

function paintAnnotations() {
  if (!current) return;
  placed = current.annotations.map((annotation) => {
    const panel = panels.find((entry) => entry.side === annotation.side);
    const expected = annotation.side === 'left' ? current.base.hash : current.revised.hash;
    const range = !annotation.needsLocation && (!annotation.fileHash || annotation.fileHash === expected)
      ? resolveRange(panel.root, annotation) : null;
    return { annotation, panel, range };
  });
  CSS.highlights.set('review-annotations', new Highlight(...placed.map((item) => item.range).filter(Boolean)));
  byId('comment-count').textContent = `人工批注（${placed.length}）`;
  const list = byId('comments');
  list.replaceChildren();
  const filter = byId('comment-filter').value;
  const visible = placed.filter(({ annotation, range }) =>
    filter === 'all' || (filter === 'locate' ? !range : annotation.status === filter));
  if (!visible.length) list.textContent = placed.length ? '此筛选条件下没有批注。' : '在任一栏选中文字后添加批注。';
  for (const { annotation, panel, range } of visible) {
    const row = dom('div', undefined, 'item');
    const state = annotation.status === 'confirmed' ? '已确认' : '待处理';
    const context = annotation.evidence;
    const location = annotationLocation(context);
    const owner = annotation.side === 'left' ? (current.baseRoundId ? '基准稿' : '原文') : '二校稿';
    row.append(dom('strong', annotation.number), dom('span', state, 'badge linked'));
    if (!range) row.append(dom('span', '待重新定位', 'badge'));
    row.append(dom('small', (range ? owner : '历史引用') + ' · ' + annotationFileName(annotation, Boolean(range)) + ' · ' + location, 'block-meta'),
      dom('small', new Date(annotation.createdAt).toLocaleString('zh-CN'), 'block-meta'));
    if (annotation.origin) {
      const previous = project.rounds.findIndex((item) => item.id === annotation.origin.roundId) + 1;
      row.append(dom('small', '来自第 ' + previous + ' 轮 · ' + annotation.origin.number, 'block-meta'));
    }
    const quote = action(annotation.quote, () => locateAndLink(annotation, panel, range));
    quote.className = 'quote-button change-text';
    quote.disabled = !range;
    row.append(quote, dom('p', annotation.comment));
    if (annotation.suggestion) row.append(dom('p', '建议：' + annotation.suggestion, 'muted'));
    const evidence = dom('details', undefined, 'annotation-evidence');
    evidence.append(dom('summary', '查看原文、二校稿和原因'),
      dom('div', '原文：' + (context?.left?.text ?? '无对应段落'), 'change-text before'),
      dom('div', '二校稿：' + (context?.right?.text ?? '无对应段落'), 'change-text after'),
      dom('div', '原因：' + (reasonFor(annotation) || '未关联修改说明'), 'change-text'));
    if (!range && annotation.reasonAtReview) {
      evidence.append(dom('div', '历史记录中的原因：' + annotation.reasonAtReview, 'change-text'));
    }
    row.append(evidence);
    const locate = action('定位', () => locateAndLink(annotation, panel, range));
    locate.disabled = !range;
    row.append(locate, action('编辑', () => editAnnotation(annotation)), action('删除', async () => {
      if (!confirm('删除这条人工批注？')) return;
      await saveAnnotations(current.annotations.filter((item) => item.id !== annotation.id));
    }));
    if (!range) row.append(action('重新定位', () => startReanchor(annotation.id)));
    if (annotation.origin && annotation.status === 'pending') row.append(action('确认已处理', () =>
      saveAnnotations(current.annotations.map((item) => item.id === annotation.id ? { ...item, status: 'confirmed' } : item))));
    list.append(row);
  }
  updateProjectSummary();
}

function locateAndLink(annotation, panel, range) {
  if (!range) return;
  const choice = changes.findIndex((item) => item.id === annotation.changeId);
  if (choice >= 0) go(choice);
  reveal(panel, range.getBoundingClientRect());
}

function startReanchor(id) {
  reanchoring = id;
  const hint = byId('reanchor-hint');
  hint.hidden = false;
  selectionButton.textContent = '将批注定位到此处';
  hint.replaceChildren(dom('span', '请在本轮文档中选取对应文字。'),
    action('取消定位', () => startReanchor(null)));
  if (id === null) {
    hint.hidden = true;
    selectionButton.textContent = '添加批注';
  }
}

function updateDetails(result, notesText) {
  const container = byId('word-comments');
  container.replaceChildren();
  const count = Object.values(result.existing).reduce((sum, list) => sum + list.length, 0);
  byId('word-count').textContent = `原有 Word 评论（${count}）`;
  for (const [side, list] of Object.entries(result.existing)) for (const item of list) {
    const row = dom('div', undefined, 'item');
    row.append(dom('small', `${sides[side]} · ${item.author || '未知作者'}`),
      dom('div', item.text || item.markdown || '（空评论）', 'change-text'));
    container.append(row);
  }
  byId('notes').textContent = current.notes
    ? current.notes.name + '\n\n' + (notesText || '此说明文件没有可提取的文本。')
    : '尚未导入。';
}

function receive(candidate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      engine.terminate();
      engine = newEngine();
      reject(new Error('文档引擎等待超时，可以重新比较'));
    // A fresh browser must download the WASM runtime on HTTPS deployments.
    }, location.protocol === 'https:' ? 120_000 : 45_000);
    engine.onmessage = ({ data }) => {
      if (data.stage) return status(data.stage);
      clearTimeout(timeout);
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    engine.onerror = (event) => {
      clearTimeout(timeout);
      engine.terminate();
      engine = newEngine();
      reject(new Error(event.message || '文档引擎加载失败'));
    };
    engine.postMessage({ appBaseUrl, original: candidate.original, edited: candidate.edited,
      notes: candidate.notes, notesOnly: candidate.notesOnly });
  });
}

const nextNumber = (round, number) => 'R' + round.order + '-A' + String(number).padStart(3, '0');

function newRound(base, revised, notes, baseRoundId, order) {
  return {
    id: crypto.randomUUID(), base, revised, notes, baseRoundId, order,
    createdAt: new Date().toISOString(), annotations: [], feedback: [], noteOverrides: {},
    nextAnnotationNumber: 1,
  };
}

function decodeNotes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
}

async function loadFiles(round) {
  const [original, edited, notes] = await Promise.all([getFile(round.base), getFile(round.revised), getFile(round.notes)]);
  return { original, edited, notes };
}

async function displayRound(nextProject, nextRound, files, commit, previousRound, preview = false) {
  const result = await receive(files);
  const { analysis, document: source } = prepareRenderedDocument(result.html, (parsed) => {
    const index = buildDocIndex(result.html, () => parsed);
    return { index, items: buildChangeItems(result.revisions, index) };
  }, sanitizedDocument);
  if (!source.body.children.length) throw new Error('引擎没有输出可显示的正文');
  const notesText = result.description ? noteDocumentText(sanitizedDocument(result.description).body)
    : files.notes ? decodeNotes(new Uint8Array(await files.notes.arrayBuffer())) : '';
  const nextRecords = nextRound.noteRecords ?? parseNotes(notesText);
  const previousPanels = panels.map((panel) => ({ nodes: [...panel.root.childNodes], top: panel.host.scrollTop }));
  let nextPositions;
  let nextChanges;
  let nextLinks;
  let saved;
  try {
    for (const panel of panels) {
      mountDocument(panel, source);
      panel.host.scrollTop = 0;
    }
    nextPositions = Object.fromEntries(panels.map((panel) => [panel.side, indexPositions(panel.root)]));
    nextChanges = analysis.items.map((change) => locateChange(change, nextPositions));
    nextLinks = assessNotes(nextRecords, nextChanges, nextPositions);
    if (preview && files.notes && !await previewNotes(nextRecords,nextLinks,nextChanges)) {
      throw new DOMException('已取消导入，项目数据未更改。','AbortError');
    }
    if (previousRound) {
      const rightRoot = panels.find((panel) => panel.side === 'right').root;
      const carried = previousRound.annotations.filter((note) => note.status !== 'confirmed').map((note, i) => {
        const copy = carryAnnotation(note, previousRound, nextRound, nextPositions.right, rightRoot);
        if (!copy.needsLocation) copy.evidence = annotationEvidence(copy, nextChanges, nextPositions);
        return { ...copy, number: nextNumber(nextRound, i + 1) };
      });
      nextRound = { ...nextRound, annotations: carried, nextAnnotationNumber: carried.length + 1 };
    }
    if (commit) {
      const annotations = nextRound.annotations.map((note, i) => ({
        ...note, number: note.number ?? nextNumber(nextRound, i + 1),
        fileHash: note.fileHash ?? (note.side === 'left' ? nextRound.base.hash : nextRound.revised.hash),
        evidence: note.evidence ?? annotationEvidence(note, nextChanges, nextPositions),
      }));
      nextRound = { ...nextRound, noteRecords: nextRecords, annotations,
        nextAnnotationNumber: Math.max(nextRound.nextAnnotationNumber, annotations.length + 1) };
      saved = await commit(nextRound);
    } else saved = nextProject;
  } catch (error) {
    for (const [i, panel] of panels.entries()) {
      panel.observer?.disconnect();
      panel.root.replaceChildren(...previousPanels[i].nodes);
      if (panel.root.querySelector('.doc')) panel.observer?.observe(panel.root.querySelector('.doc'));
      scrollTo(panel, previousPanels[i].top);
    }
    anchorPairs.clear();
    if (current) paintAnnotations();
    throw error;
  }
  project = saved;
  current = project.rounds.find((round) => round.id === nextRound.id);
  positionsBySide = nextPositions;
  changes = nextChanges;
  records = nextRecords;
  assessments = nextLinks;
  index = changes.length ? 0 : -1;
  anchorPairs.clear();
  startReanchor(null);
  closeSelectionCard();
  byId('left-role').textContent = current.baseRoundId ? '基准稿' : '原文';
  byId('left-name').textContent = current.base.name;
  byId('right-name').textContent = current.revised.name;
  byId('note-filter').value = 'all';
  byId('comment-filter').value = 'all';
  updateDetails(result, notesText);
  renderChanges();
  paintAnnotations();
  byId('change').textContent = '两份文档的正文未检测到修改。';
  if (index >= 0) go(index, false);
  else renderNotes();
  setImportMode('hidden');
  await refreshProjects();
  await setActive(project.id, current.id);
  const unresolved = placed.filter(({ range }) => !range).length;
  status(`${commit ? '已比较并保存' : '已恢复'} · ${changes.length} 处修改 · ${result.duration} ms` +
    (unresolved ? ` · ${unresolved} 条批注待重新定位` : '') +
    (result.untagged ? ` · ${result.untagged} 个修订标记需要核对` : ''));
}

async function run(message, task) {
  if (running || saving) return;
  running = true;
  updateProjectSummary();
  try {
    await task();
  } catch (error) {
    byId('project-select').value = project?.id ?? '';
    if (error.name === 'AbortError') status(error.message);
    else status(message + ' · ' + error.message, true);
  } finally {
    running = false;
    updateProjectSummary();
  }
}

async function persistRound(patch, message) {
  if (!current || running || saving) return false;
  saving = true;
  updateProjectSummary();
  try {
    const next = { ...current, ...patch };
    project = await saveRound(project.id, next, project.version);
    current = next;
    status(message);
    return true;
  } catch (error) {
    status(`保存失败 · ${error.message}`, true);
    return false;
  } finally {
    saving = false;
    updateProjectSummary();
  }
}

async function saveAnnotations(annotations, counter = current.nextAnnotationNumber) {
  if (!await persistRound({ annotations, nextAnnotationNumber: counter }, `批注已保存 · ${annotations.length} 条`)) return false;
  paintAnnotations();
  if (index >= 0) go(index, false);
  return true;
}

function editAnnotation(annotation) {
  if (running || saving) return;
  editing = annotation;
  byId('quote').textContent = annotation.quote;
  byId('comment-text').value = annotation.comment ?? '';
  byId('comment-suggestion').value = annotation.suggestion ?? '';
  byId('comment-status').value = annotation.status ?? 'pending';
  dialog.showModal();
  byId('comment-text').focus();
}

async function refreshProjects() {
  const projects = await listProjects();
  byId('project-select').replaceChildren(new Option('选择项目', ''),
    ...projects.map((item) => new Option(item.name, item.id)));
  byId('project-select').value = project?.id ?? '';
}

function setImportMode(mode) {
  importMode = mode;
  const form = byId('import');
  form.reset();
  form.hidden = mode === 'hidden';
  const create = mode === 'project';
  byId('project-name-field').hidden = !create;
  byId('original-field').hidden = !create;
  byId('left-file').required = create;
  byId('base-field').hidden = create;
  byId('compare').textContent = create ? '创建项目' : '保存并比较新轮次';
  byId('cancel-import').hidden = !project;
  byId('restore-empty').hidden = !create;
  if (mode === 'round') {
    const latest = project.rounds.at(-1);
    byId('base-select').replaceChildren(
      new Option('上一轮二校稿 · ' + latest.revised.name, latest.id),
      new Option('最初原文 · ' + project.original.name, 'original'));
  }
}

async function openProject(id, roundId) {
  await run('打开项目失败', async () => {
    const next = await getProject(id);
    if (!next) throw new Error('找不到该项目。');
    const round = next.rounds.find((item) => item.id === roundId) ?? next.rounds.at(-1);
    const present = await loadFiles(round);
    await displayRound(next, round, present);
  });
}

for (const panel of panels) {
  const other = panels.find((entry) => entry !== panel);
  panel.host.addEventListener('scroll', () => {
    if (selection?.side === panel.side) scheduleSelectionPlacement();
    const ignored = scrollExpected.get(panel.host);
    scrollExpected.delete(panel.host);
    if (byId('sync').checked && (ignored === undefined || Math.abs(ignored - panel.host.scrollTop) > 1)) {
      syncPanel(panel, other);
    }
  }, { passive: true });
  panel.root.addEventListener('pointerup', () => {
    if (running || saving || !current) return;
    const anchor = captureAnchor(panel.root, panel.side);
    if (!anchor) {
      closeSelectionCard();
      return;
    }
    showSelectionCard(anchor.model, anchor.pin);
  });
  panel.root.addEventListener('click', (event) => {
    if (window.getSelection().toString()) return;
    const note = placed.find((item) => item.panel === panel && item.range &&
      [...item.range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom));
    if (note) {
      editAnnotation(note.annotation);
      return;
    }
    const hit = event.target.closest('[data-change-id]');
    if (hit) go(changes.findIndex((item) => item.id === hit.dataset.changeId));
  });
}

byId('selection-close').addEventListener('click', closeSelectionCard);
document.addEventListener('click', (event) => {
  const path = event.composedPath();
  if (!selectionCard.hidden && !path.includes(selectionCard) && !panels.some(({ host }) => path.includes(host))) {
    closeSelectionCard();
  }
}, true);
window.addEventListener('scroll', scheduleSelectionPlacement, { passive: true });
window.addEventListener('resize', scheduleSelectionPlacement);
selectionButton.addEventListener('pointerdown', (event) => event.preventDefault());
selectionButton.addEventListener('click', async () => {
  if (!selection || running || saving) return;
  const selected = selection;
  closeSelectionCard();
  window.getSelection().removeAllRanges();
  if (!reanchoring) return editAnnotation(selected);
  const id = reanchoring;
  const annotations = current.annotations.map((note) => note.id === id
    ? { ...note, parts: undefined, changeIds: undefined, ...selected, needsLocation: false,
      fileHash: selected.side === 'left' ? current.base.hash : current.revised.hash,
      evidence: annotationEvidence(selected, changes, positionsBySide),
      reasonAtReview: reasonFor(selected) }
    : note);
  if (await saveAnnotations(annotations)) startReanchor(null);
});
byId('cancel').addEventListener('click', () => dialog.close());
byId('comment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const comment = byId('comment-text').value.trim();
  if (!comment || !editing || running) return;
  const button = event.submitter;
  if (button) button.disabled = true;
  const annotation = {
    ...editing, id: editing.id ?? crypto.randomUUID(), createdAt: editing.createdAt ?? new Date().toISOString(),
    number: editing.number ?? nextNumber(current, current.nextAnnotationNumber),
    fileHash: editing.fileHash ?? (editing.side === 'left' ? current.base.hash : current.revised.hash),
    evidence: editing.evidence ?? annotationEvidence(editing, changes, positionsBySide),
    reasonAtReview: reasonFor(editing),
    comment, suggestion: byId('comment-suggestion').value.trim(), status: byId('comment-status').value,
  };
  const notes = editing.id ? current.annotations.map((item) => item.id === annotation.id ? annotation : item) :
    [...current.annotations, annotation];
  try {
    if (await saveAnnotations(notes, current.nextAnnotationNumber + (editing.id ? 0 : 1))) dialog.close();
  } finally {
    if (button) button.disabled = false;
  }
});
byId('import').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running || saving) return;
  const original = byId('left-file').files[0];
  const edited = byId('right-file').files[0];
  const notes = byId('notes-file').files[0] ?? null;
  const creating = importMode === 'project';
  if (!(creating ? [original, edited] : [edited]).every((file) => file && /\.docx$/i.test(file.name)) ||
      (notes && !/\.(docx|md|txt)$/i.test(notes.name))) {
    status('请选择 DOCX 原文和二校稿。修改说明支持 DOCX、Markdown 或 TXT。', true);
    return;
  }
  const name = byId('project-name').value.trim();
  const selectedBase = byId('base-select').value;
  await run('比较失败', async () => {
    const [left, right, explanation] = await Promise.all([
      creating ? stageFile(original) : null, stageFile(edited), notes ? stageFile(notes) : null,
    ]);
    if (creating) {
      const round = newRound(left.ref, right.ref, explanation?.ref ?? null, null, 1);
      const next = createProject(name || original.name.replace(/\.docx$/i, ''), left.ref, round);
      await displayRound(next, round, { original, edited, notes }, async (readyRound) => {
        const saved = { ...next, rounds: [readyRound] };
        await saveNewProject(saved, [left, right, explanation]);
        return saved;
      }, null, true);
    } else {
      const previous = project.rounds.at(-1);
      const baseline = selectedBase === 'original' ? null : previous;
      const base = baseline?.revised ?? project.original;
      const round = newRound(base, right.ref, explanation?.ref ?? null, baseline?.id ?? null, project.rounds.length + 1);
      await displayRound(project, round, { original: await getFile(base), edited, notes },
        (readyRound) => saveRound(project.id, readyRound, project.version, [right, explanation], true), previous, true);
    }
  });
});
byId('prev').addEventListener('click', () => go(index - 1));
byId('next').addEventListener('click', () => go(index + 1));
byId('jump').addEventListener('change', (event) => go(Number(event.target.value)));
byId('project-select').addEventListener('change', (event) => {
  if (event.target.value) openProject(event.target.value);
  else byId('project-select').value = project?.id ?? '';
});
byId('new-project').addEventListener('click', () => setImportMode('project'));
byId('new-round').addEventListener('click', () => setImportMode('round'));
byId('cancel-import').addEventListener('click', () => setImportMode('hidden'));
byId('note-filter').addEventListener('change', renderNotes);
byId('comment-filter').addEventListener('change', paintAnnotations);
byId('notes-update').addEventListener('click', () => {
  if (current && !running && !saving) byId('notes-update-file').click();
});
byId('notes-update-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !current) return;
  if (!/\.(docx|md|txt)$/i.test(file.name)) return status('修改说明支持 DOCX、Markdown 或 TXT。', true);
  await run('修改说明导入失败', async () => {
    status('正在读取修改说明…');
    const staged = await stageFile(file);
    const notesText = /\.docx$/i.test(file.name)
      ? noteDocumentText(sanitizedDocument((await receive({ notes: file, notesOnly: true })).description).body)
      : decodeNotes(new Uint8Array(await file.arrayBuffer()));
    const noteRecords = parseNotes(notesText);
    const nextAssessments = assessNotes(noteRecords, changes, positionsBySide);
    // Ordinal record IDs can shift when a heading or malformed row is added.
    // Transfer an override only if an identical raw record occurs exactly once in each file.
    const identical = current.notes?.hash === staged.ref.hash && records.length === noteRecords.length &&
      records.every((r,i) => r.id === noteRecords[i].id && r.raw === noteRecords[i].raw);
    const overrides = identical ? { ...current.noteOverrides } : {};
    const indexed = (list) => {
      const map = new Map();
      for (const note of list) map.set(note.raw, map.has(note.raw) ? null : note);
      return map;
    };
    const old = indexed(records), fresh = indexed(noteRecords);
    for (const [raw,note] of fresh) {
      const prior = old.get(raw);
      if (note && prior && prior.location === note.location && Object.hasOwn(current.noteOverrides,prior.id)) {
        overrides[note.id] = current.noteOverrides[prior.id];
      }
    }
    if (!await previewNotes(noteRecords,nextAssessments,changes,overrides)) return status('已取消导入，保留本轮原有修改说明。');
    const next = { ...current, notes: staged.ref, noteRecords, noteOverrides: overrides };
    project = await saveRound(project.id, next, project.version, [staged]);
    current = next;
    records = noteRecords;
    assessments = nextAssessments;
    byId('notes').textContent = current.notes.name + '\n\n' + (notesText || '此说明文件没有可提取的文本。');
    byId('note-filter').value = 'all';
    paintAnnotations();
    if (index >= 0) go(index, false);
    else renderNotes();
    status('已导入修改说明 · ' + noteRecords.length + ' 条记录');
  });
});
byId('width').addEventListener('input', (event) => {
  const width = Number(event.target.value);
  byId('columns').style.setProperty('--left', `${width}fr`);
  byId('columns').style.setProperty('--right', `${100 - width}fr`);
  anchorPairs.clear();
});
byId('toggle').addEventListener('click', (event) => {
  const details = byId('details');
  const open = details.hidden;
  details.hidden = !open;
  byId('workspace').classList.toggle('closed', !open);
  event.currentTarget.textContent = open ? '隐藏修改记录' : '显示修改记录';
  event.currentTarget.setAttribute('aria-expanded', String(open));
});

const feedbackDialog = byId('feedback-dialog');
const feedbackSelection = new Set();
let archivedFeedback = null;

function reportAnnotations() {
  return placed.filter(({ annotation }) => feedbackSelection.has(annotation.id)).map(({ annotation, range }) => {
    const evidence = annotation.evidence;
    const needsLocation = !range;
    const previous = annotation.origin && project.rounds.findIndex((round) => round.id === annotation.origin.roundId) + 1;
    return {
      ...annotation, needsLocation,
      fileName: (needsLocation && previous ? '第 ' + previous + ' 轮历史引用 · ' : '') +
        annotationFileName(annotation, !needsLocation),
      location: annotationLocation(evidence),
      before: evidence?.left?.text ?? (annotation.side === 'left' ? annotation.paragraph : ''),
      after: evidence?.right?.text ?? (annotation.side === 'right' ? annotation.paragraph : ''),
      reason: reasonFor(annotation) || (needsLocation && annotation.reasonAtReview
        ? '历史记录中的原因：' + annotation.reasonAtReview : ''),
    };
  });
}

function updateFeedbackPreview() {
  const annotations = reportAnnotations();
  byId('feedback-preview').value = annotations.length ? makeFeedback({
    projectName: project.name, originalName: project.original.name, baseName: current.base.name,
    revisedName: current.revised.name, roundNumber: current.order,
    date: new Intl.DateTimeFormat('sv-SE').format(new Date()), annotations,
  }) : '';
  for (const id of ['feedback-copy', 'feedback-export', 'feedback-save']) byId(id).disabled = !annotations.length;
  byId('feedback-status').textContent = annotations.length ? '已选择 ' + annotations.length + ' 条批注' : '请选择需要纳入反馈的批注。';
}

function renderFeedbackOptions() {
  const list = byId('feedback-list');
  list.replaceChildren();
  const includeConfirmed = byId('include-confirmed').checked;
  for (const { annotation, range } of placed) {
    if (!includeConfirmed && annotation.status === 'confirmed') continue;
    const label = dom('label');
    const check = dom('input');
    check.type = 'checkbox';
    check.checked = feedbackSelection.has(annotation.id);
    check.addEventListener('change', () => {
      if (check.checked) feedbackSelection.add(annotation.id);
      else feedbackSelection.delete(annotation.id);
      updateFeedbackPreview();
    });
    label.append(check, dom('span', annotation.number + ' · ' + (range ? '' : '待重新定位 · ') +
      (annotation.status === 'confirmed' ? '已确认 · ' : '') + annotation.quote));
    list.append(label);
  }
  if (!list.children.length) list.textContent = '没有符合条件的批注。';
  updateFeedbackPreview();
}

function openFeedback(snapshot = null) {
  archivedFeedback = snapshot;
  byId('feedback-options').hidden = Boolean(snapshot);
  byId('feedback-save').hidden = Boolean(snapshot);
  byId('feedback-title').textContent = snapshot ? '历史反馈 · ' + new Date(snapshot.createdAt).toLocaleString('zh-CN') : '生成反馈';
  if (snapshot) {
    byId('feedback-preview').value = snapshot.markdown;
    byId('feedback-status').textContent = '';
    byId('feedback-copy').disabled = false;
    byId('feedback-export').disabled = false;
  } else {
    feedbackSelection.clear();
    for (const { annotation, range } of placed) {
      if (annotation.status === 'pending' && range) feedbackSelection.add(annotation.id);
    }
    byId('include-confirmed').checked = false;
    renderFeedbackOptions();
  }
  feedbackDialog.showModal();
}

async function saveFeedbackSnapshot(markdown) {
  if (archivedFeedback || current.feedback.some((item) => item.markdown === markdown)) return true;
  const saved = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), markdown,
    annotationIds: [...feedbackSelection] };
  return persistRound({ feedback: [...current.feedback, saved] }, '已保存本轮反馈');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = dom('a');
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyFeedback(markdown) {
  try {
    await navigator.clipboard.writeText(markdown);
  } catch {
    const preview = byId('feedback-preview');
    preview.focus();
    preview.select();
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，已选中反馈文字。');
  }
}

async function feedbackAction(mode) {
  if (running || saving) return;
  const markdown = byId('feedback-preview').value;
  if (!markdown) return;
  const output = byId('feedback-status');
  try {
    let message = '已保存到本轮历史。';
    if (mode === 'copy') {
      await copyFeedback(markdown);
      message = '已复制全部反馈。';
    }
    if (mode === 'export') {
      download(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
        project.name + '-第' + current.order + '轮-二校反馈.md');
      message = '已导出 Markdown。';
    }
    const saved = await saveFeedbackSnapshot(markdown);
    output.textContent = saved ? message : (mode === 'save' ? '保存失败。' : message + '历史记录保存失败。');
  } catch (error) {
    output.textContent = error.message;
  }
}

byId('feedback').addEventListener('click', () => openFeedback());
byId('feedback-close').addEventListener('click', () => feedbackDialog.close());
byId('include-confirmed').addEventListener('change', () => {
  if (!byId('include-confirmed').checked) {
    for (const { annotation } of placed) if (annotation.status === 'confirmed') feedbackSelection.delete(annotation.id);
  }
  renderFeedbackOptions();
});
byId('feedback-copy').addEventListener('click', () => feedbackAction('copy'));
byId('feedback-export').addEventListener('click', () => feedbackAction('export'));
byId('feedback-save').addEventListener('click', () => feedbackAction('save'));

const historyDialog = byId('history-dialog');

function renderHistory() {
  const list = byId('round-list');
  list.replaceChildren();
  for (const round of [...project.rounds].reverse()) {
    const row = dom('article', undefined, 'history-round');
    const pending = round.annotations.filter((note) => note.status === 'pending').length;
    row.append(dom('strong', '第 ' + round.order + ' 轮 · ' + round.revised.name),
      dom('small', '基准：' + round.base.name + ' · ' + new Date(round.createdAt).toLocaleString('zh-CN'), 'block-meta'),
      dom('small', '批注 ' + round.annotations.length + ' 条 · 待处理 ' + pending + ' 条 · 反馈 ' + round.feedback.length + ' 份', 'block-meta'));
    if (round.notes) row.append(dom('small', '说明：' + round.notes.name, 'block-meta'));
    if (round.id === current.id) row.append(dom('span', '当前轮次', 'badge linked'));
    else row.append(action('打开第 ' + round.order + ' 轮', () => {
      historyDialog.close();
      openProject(project.id, round.id);
    }));
    for (const [i, snapshot] of round.feedback.entries()) {
      row.append(action('查看反馈 ' + (i + 1), async () => {
        const projectId = project.id;
        historyDialog.close();
        if (current.id !== round.id) await openProject(projectId, round.id);
        if (project?.id === projectId && current?.id === round.id) openFeedback(snapshot);
      }));
    }
    list.append(row);
  }
}

byId('history').addEventListener('click', () => {
  renderHistory();
  historyDialog.showModal();
});
byId('history-close').addEventListener('click', () => historyDialog.close());
byId('backup').addEventListener('click', () => {
  historyDialog.close();
  run('备份失败', async () => {
    status('正在生成项目备份…');
    const backup = await exportProject(project);
    download(backup, project.name + '-项目备份.zip');
    status('已下载项目备份');
  });
});
for (const id of ['restore', 'restore-empty']) {
  byId(id).addEventListener('click', () => byId('restore-file').click());
}
byId('restore-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  historyDialog.close();
  run('恢复备份失败', async () => {
    status('正在校验备份中的文件…');
    const { project: restored, staged } = await restoreProject(file);
    const round = restored.rounds.at(-1);
    const localFile = (ref) => ref ? new File([staged.find((item) => item.ref.hash === ref.hash).file], ref.name, { type: ref.type }) : null;
    await displayRound(restored, round, { original: localFile(round.base), edited: localFile(round.revised),
      notes: localFile(round.notes) }, async (readyRound) => {
      const saved = { ...restored, rounds: [...restored.rounds.slice(0, -1), readyRound] };
      await saveNewProject(saved, staged);
      return saved;
    });
    status('已恢复备份 · 保存为独立项目');
  });
});

document.addEventListener('keydown', (event) => {
  if (!selectionCard.hidden && event.key === 'Escape') {
    closeSelectionCard();
    return;
  }
  if (dialog.open && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    byId('comment-form').requestSubmit();
  }
  if (!document.querySelector('dialog[open]') && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    go(index + (event.key === 'ArrowUp' ? -1 : 1));
  }
});

async function bootstrap() {
  await refreshProjects();
  const active = await getActive();
  if (active) return openProject(active.projectId, active.roundId);
  if (await wasMigrated()) return;
  const previous = await getLegacy();
  if (!previous?.original || !previous?.edited) return;
  await run('无法恢复原型记录', async () => {
    const [left, right, notes] = await Promise.all([stageFile(previous.original), stageFile(previous.edited),
      previous.notes ? stageFile(previous.notes) : null]);
    const round = { ...newRound(left.ref, right.ref, notes?.ref ?? null, null, 1), annotations: previous.annotations ?? [] };
    const next = createProject(left.ref.name.replace(/\.docx$/i, ''), left.ref, round);
    await displayRound(next, round, previous, async (migrated) => {
      const saved = { ...next, rounds: [migrated] };
      await saveNewProject(saved, [left, right, notes], true);
      return saved;
    });
  });
}

bootstrap().catch((error) => status(`无法读取本地记录 · ${error.message}`, true));
