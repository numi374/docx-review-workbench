const aliases = {
  before: '修改前|改前|修订前|原文|原句|原表述|原内容|修改前内容|原始内容|原始文本|before|original',
  after: '修改后|改后|修订后|二校内容|二校稿|修改稿|改为|修改后内容|修改为|改写后|修订内容|新内容|修改结果|after|revised',
  reason: '修改原因|修改理由|修订原因|修改依据|调整说明|修改说明|原因|理由|依据|reason|rationale',
  location: '相关段落|所在章节|对应位置|相关章节|位置|章节|段落|定位|location|section',
  type: '修改类型|变更类型|操作类型|类型|type',
  context: '上下文|前后文|context',
  number: '修改记录编号|修改编号|记录编号|编号|序号|记录|id|no\\.?',
};
const keys = Object.entries(aliases).map(([key, names]) => [key, new RegExp('^(?:' + names + ')$', 'i')]);
const labels = Object.values(aliases).join('|');
const fieldPattern = new RegExp('(?:^|[\\s，,；;])(?:\\*\\*|__)?(' + labels + ')(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?', 'gi');
const headingPattern = /^(?:(?:修改记录|修改项|修改|修订记录|修订项|修订|变更|问题|change)\s*(?:第\s*)?(?:#\s*)?([0-9]+(?:[.-][0-9]+)*|[一二三四五六七八九十]+)(?![0-9])|(?:第\s*)?([0-9]+|[一二三四五六七八九十]+)\s*(?:条|项|[、.．)）])\s*)/iu;
const blank = /^(?:[—–\-]+|无|空|新增|删除|（无）|\(无\)|n\/a|none|∅)$/i;
const clean = (value) => value.trim().replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
const fieldKey = (value) => keys.find(([, pattern]) => pattern.test(clean(value).replace(/[:：]$/, '')))?.[0];
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((value) => clean(value.replace(/\\\|/g, '|')));
const divider = (line) => /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line);

function record(fields, raw, index) {
  const result = { id: 'note-' + (index + 1), number: '', before: '', after: '', reason: '', location: '', ...fields };
  result.raw = raw.trim();
  result.emptyBefore = blank.test(result.before);
  result.emptyAfter = blank.test(result.after);
  if (result.emptyBefore) result.before = '';
  if (result.emptyAfter) result.after = '';
  return result;
}

// Extract explicit rewrites and preserve the surrounding explanation separately.
const quotation = /“([^”]+)”|「([^」]+)」|『([^』]+)』|‘([^’]+)’|"([^"]+)"/gu;
function narrative(body) {
  const quotes = [...body.matchAll(quotation)];
  const value = (m) => m.slice(1).find((part) => part !== undefined);
  const first = quotes[0];
  // Proposed, illustrative, or negated rewrites are not evidence of an applied change.
  if (/(?:不应|不要|不得|不宜|建议|如果|例如|比如|考虑|尚未|是否|可以尝试|should|could|might|example)/iu.test(body.slice(0,first?.index ?? body.length))) return null;
  if (!first) {
    const plain = /^(?:(第[零〇一二三四五六七八九十百\d]+[章节段])\s*[，,：:]?\s*)?(?:已)?[将把]\s*([^，,。；;：:\n]+?)\s*(?:修改为|替换为|调整为|改为|改成)\s*([^，,。；;\n]+?)(?:[，,；;]\s*(?:因为|原因是|以便|原因[：:])\s*(.+)|[。.]?)$/u.exec(body);
    if (!plain) return null;
    return { location: plain[1] || '', before: plain[2].trim(), after: plain[3].trim(), reason: plain[4] || '' };
  }
  const prefix = body.slice(0, first.index);
  let fields;
  let last = first;
  const second = quotes[1];
  if (second && /^\s*(?:修改为|替换为|调整为|改写为|改成|改为|换成|变为|→|->|to|with)\s*$/iu.test(
    body.slice(first.index + first[0].length, second.index))) {
    fields = { before: value(first), after: value(second) };
    last = second;
  } else if (/(?:新增|插入|补充|添加|added?)\s*[:：]?\s*$/iu.test(prefix)) {
    fields = { before: '∅', after: value(first) };
  } else if (/(?:删除|删去|移除|removed?|deleted?)\s*[:：]?\s*$/iu.test(prefix)) {
    fields = { before: value(first), after: '∅' };
  } else return null;
  const place = prefix.match(/第\s*[零〇一二三四五六七八九十百\d]+\s*[章节段](?:\s*第\s*\d+\s*段)?/u);
  if (place) fields.location = place[0];
  const rest = body.slice(last.index + last[0].length).replace(/^[，,。；;：:\s]+/, '');
  if (rest) fields.reason = rest.replace(/^(?:原因是|理由是|原因[：:]|因为|以便|because\s+)/iu, '').trim();
  return fields;
}

export function parseNotes(text) {
  const records = [];
  let fields = {};
  let raw = [];
  let active = '';
  let section = '';
  let title = '';
  let narrativeRecord = false;
  let table = null;
  const flush = () => {
    if (raw.some((line) => line.trim()) || Object.keys(fields).length) {
      records.push(record({ location: section, title, ...fields }, raw.join('\n'), records.length));
    }
    fields = {};
    raw = [];
    active = '';
    title = '';
    narrativeRecord = false;
  };
  const emit = (row, line) => records.push(record({ location: section, ...row }, line, records.length));
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    const content = line.trim();
    if (!content) {
      if (raw.length) raw.push('');
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(content)) { flush(); table = null; continue; }
    if (content.includes('|')) {
      if (divider(content)) continue;
      const values = cells(content);
      const headers = values.map(fieldKey);
      if (headers.filter(Boolean).length >= 2 && headers.some((key) => ['before','after','reason'].includes(key))) {
        flush();
        table = headers;
        continue;
      }
      if (table) {
        const row = {};
        if (values.length === table.length) table.forEach((key, i) => { if (key) row[key] = values[i]; });
        else row.warning = '表格列数与表头不一致，请查看原始行。';
        emit(row, content);
        continue;
      }
    }
    table = null;
    const heading = /^(#{1,6})\s+(.+)$/.exec(content);
    let body = clean((heading?.[2] ?? content).replace(/^(?:[-*+]\s+|>\s*)+/, ''));
    if (/^(?:codex\s*)?(?:二校)?(?:修改说明|修订说明|修改记录|校对记录|change\s*log)$/iu.test(body) && (heading || (!raw.length && !records.length))) {
      flush();
      continue;
    }
    const bare = fieldKey(body);
    const id = /^(CHG[-‐‑–]\d+)(?=$|[\s:：、.．)）-])/iu.exec(body)
      ?? headingPattern.exec(body)
      ?? ((!active || fields[active] || heading) && /^(\d{2,})(?:$|\s*[:：、]\s*)/u.exec(body));
    if (id && !bare && (heading || !active || fields[active] || !/^[\d.．\s]+$/u.test(body))) {
      flush();
      fields.number = id[1] ?? id[2];
      body = body.slice(id[0].length).replace(/^[\s:：、.．)）-]+/, '');
    }
    const labeled = [...body.matchAll(fieldPattern)];
    const prose = labeled[0]?.index === 0 ? null : narrative(body);
    const matches = prose ? [] : labeled;
    if (heading && !id && !bare && !prose && !matches.length) {
      flush();
      if (/^第.+?[章节]|^chapter\s+\d+/iu.test(body)) section = body;
      else if (!/^(?:codex\s*)?(?:二校)?(?:修改说明|修订说明|修改记录|校对记录|change\s*log)$/iu.test(body)) title = body;
      continue;
    }
    if (bare || matches.length) {
      const items = bare ? [[bare, '']] : matches.map((match,i) => [fieldKey(match[1]),
        clean(body.slice(match.index + match[0].length, matches[i+1]?.index).replace(/[，,；;]\s*$/, ''))]);
      if (items.some(([key]) => key in fields && ['before','number','reason'].includes(key))) flush();
      for (const [key, value] of items) { fields[key] = value; active = key; }
      raw.push(content);
      continue;
    }
    if (prose) {
      if (fields.before || fields.after || fields.reason || (!fields.number && raw.length)) flush();
      Object.assign(fields, prose);
      if (!fields.location) delete fields.location;
      narrativeRecord = true;
      active = 'reason';
    } else if (body && (!id || active)) {
      if ((!active || narrativeRecord) && raw.at(-1) === '') flush();
      if (active) fields[active] = [fields[active], body].filter(Boolean).join('\n');
    }
    raw.push(content);
  }
  flush();
  return records;
}

export function noteDocumentText(body) {
  const lines = [];
  const text = (node) => node.nodeType === 3 ? node.data : node.nodeName === 'BR' ? '\n' :
    [...node.childNodes].map(text).join('');
  const walk = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'table') {
      for (const row of element.rows) {
        lines.push('| ' + [...row.cells].map((cell) =>
          ([...cell.children].map(text).join(' ') || text(cell))
            .replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')).join(' | ') + ' |');
      }
    } else if (/^h[1-6]$/.test(tag)) {
      lines.push('#'.repeat(Number(tag[1])) + ' ' + text(element).trim());
    } else if (/^(p|li|pre|blockquote)$/.test(tag) || !element.children.length) {
      const value = text(element).trim();
      lines.push(value, '');
    } else {
      for (const child of element.children) walk(child);
    }
  };
  for (const element of body.children) walk(element);
  return lines.join('\n');
}

export { assessNotes, suggestLinks } from './note-matching.mjs';
