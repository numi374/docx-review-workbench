import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessNotes, parseNotes, suggestLinks } from '../src/notes.mjs';

test('parses labeled records, Word-style separate labels and Markdown table rows', () => {
  const notes = parseNotes([
    '## 修改一', '修改前', '原来的表述', '修改后', '更新后的表述', '原因：核实语义。',
    '', '| 编号 | 位置 | 原文 | 修改后 | 修改原因 |', '| --- | --- | --- | --- | --- |',
    '| A8 | 第 3 段 | 24 | 12 | 统一时长 |',
  ].join('\n'));
  assert.equal(notes.length, 2);
  assert.equal(notes[0].number, '一');
  assert.equal(notes[0].before, '原来的表述');
  assert.equal(notes[0].after, '更新后的表述');
  assert.equal(notes[1].number, 'A8');
  assert.equal(notes[1].location, '第 3 段');
  assert.equal(notes[1].reason, '统一时长');
});

function change(id, section, number) {
  return { id, kind: 'replaced', removedText: '24', addedText: '12',
    left: { number, text: '恢复时长 24 小时', section },
    right: { number, text: '恢复时长 12 小时', section } };
}

test('never guesses repeated content; accepts a unique corroborated location', () => {
  const candidates = [change('a', '第一章 恢复', 5), change('b', '第二章 验证', 9)];
  const duplicate = parseNotes('修改前：24\n修改后：12\n原因：统一时长');
  assert.deepEqual(suggestLinks(duplicate, candidates), {});
  const located = parseNotes('修改前：24\n修改后：12\n原因：统一时长\n位置：第二章第9段');
  assert.deepEqual(suggestLinks(located, candidates), { 'note-1': 'b' });
  const reasonOnly = parseNotes('原因：核实全文');
  assert.deepEqual(suggestLinks(reasonOnly, candidates), {});
});

test('one-sided records need an explicit absent side or corroborated position', () => {
  const insert = { id: 'new', kind: 'inserted', removedText: '', addedText: '补充验证记录。',
    right: { number: 7, text: '补充验证记录。', section: '恢复目标' } };
  assert.deepEqual(suggestLinks(parseNotes('修改后：补充验证记录。'), [insert]), {});
  assert.deepEqual(suggestLinks(parseNotes('修改前：无\n修改后：补充验证记录。'), [insert]), { 'note-1': 'new' });
});

test('mixed headings, punctuation labels and isolated malformed rows preserve later records', () => {
  const notes = parseNotes('# 修改说明\n001\n原文：甲，修改稿：乙；修改依据：术语\n---\n' +
    '## CHG-007\nBefore\n12.5\nAfter\n13.6\nReason: 精度\n' +
    '| 位置 | 修改原因 |\n| --- | --- |\n| 不完整 |\n| 第2段 | 复核单位 |\n');
  assert.equal(notes.length, 4);
  assert.deepEqual([notes[0].number,notes[0].before,notes[0].after,notes[0].reason], ['001','甲','乙','术语']);
  assert.deepEqual([notes[1].number,notes[1].before,notes[1].after], ['CHG-007','12.5','13.6']);
  assert.match(notes[2].warning,/列数/);
  assert.equal(notes[3].location,'第2段');
});

test('narrative extraction keeps reasons, suggestions and examples apart', () => {
  const notes = parseNotes('将“甲”改为“乙”，原因：规范用词。\n\n将BLUE改为RED，因为色标变更。\n\n' +
    '例如将“甲”改为“乙”，只是示例。\n---\n原因：将“甲”改为“乙”仍需审批。');
  assert.deepEqual(notes.map((n) => [n.before,n.after]),[['甲','乙'],['BLUE','RED'],['',''],['','']]);
  assert.equal(notes[0].reason,'规范用词。');
});

test('duplicate changes between already located records are never inferred from ordering', () => {
  const doc = [change('a','第一章',4),change('b','第一章',5),change('c','第一章',7)];
  const notes = parseNotes('原文：24\n修改后：12\n位置：第4段\n原文：24\n修改后：12\n位置：第一章\n原文：24\n修改后：12\n位置：第7段');
  const results = Object.values(assessNotes(notes,doc));
  assert.deepEqual(results.map((r) => r.ids),[['a'],[],['c']]);
  assert.equal(results[1].confidence,'medium');
  assert.equal(results[1].candidates.length,3);
});

test('partial digits, conflicting locations and unilateral evidence cannot auto-confirm a replacement', () => {
  const doc = [change('a','第一章',4)];
  for (const input of ['原文：2\n修改后：1','原文：24\n修改后：12\n位置：第5段','原文：24\n修改后：99','原文：24']) {
    const [r] = Object.values(assessNotes(parseNotes(input),doc));
    assert.notEqual(r.confidence,'high',input);
    assert.deepEqual(r.ids,[]);
  }
});

test('per-side change spans separate two edits in the same paragraph', () => {
  const l = { text:'甲案与丙案。', anchor:'P', number:2, section:'附件' };
  const r = { ...l, text:'乙案与丁案。' };
  const edits = [{id:'a',removedText:'甲',addedText:'乙'},{id:'b',removedText:'丙',addedText:'丁'}]
    .map((c) => ({...c,kind:'replaced',left:l,right:r}));
  const notes = parseNotes('原文：甲\n修改稿：乙\n原文：丙\n修改稿：丁\n原文：甲\n修改稿：丁');
  const results = Object.values(assessNotes(notes,edits));
  assert.deepEqual(results.map((x) => x.ids),[['a'],['b'],[]]);
});

test('typographic variants and surrounding context can corroborate complete change spans', () => {
  const doc = [change('a','第一章',5),change('b','第二章',9)];
  doc[1].left.text += '（夜班）';
  const note = parseNotes('Before: 恢复时长２４小时\nAfter: 恢复时长１２小时\n上下文：夜班');
  const [r] = Object.values(assessNotes(note,doc));
  assert.deepEqual(r.ids,['b']);
  assert.match(r.evidence.join(''),/全半角/);
});

test('context in the quote paragraph takes precedence over the same context in its neighbour', () => {
  const changes = [change('a', '恢复', 5), change('b', '恢复', 6)];
  changes[1].left.text += '（夜班）';
  changes[1].right.text += '（夜班）';
  const notes = parseNotes('原文：24\n修改稿：12\n上下文：夜班');
  const result = assessNotes(notes, changes)['note-1'];
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.ids, ['b']);
  assert.deepEqual(result.candidates, [['b']]);
});

test('adjacent context is kept for review and will not be assembled across a paragraph boundary', () => {
  const candidate = change('a', '恢复', 5);
  const positions = Object.fromEntries(['left', 'right'].map((side) => {
    const entry = candidate[side];
    return [side, {
      entries: [entry, { number: 6, section: '恢复', text: '夜班' }],
      spansByEntry: [[{ id: 'a', start: 5, end: 7 }], []],
    }];
  }));
  for (const context of ['夜班', '小时夜班']) {
    const notes = parseNotes('原文：24\n修改稿：12\n上下文：' + context);
    const result = assessNotes(notes, [candidate], positions)['note-1'];
    assert.equal(result.confidence, 'medium', context);
    assert.deepEqual(result.ids, [], context);
    assert.deepEqual(result.candidates, [['a']], context);
    assert.equal(result.evidence.some((line) => line.includes('仅出现在同章节的相邻段落')), context === '夜班');
  }
});

test('a chapter hint distinguishes local context repeated in neighbouring candidates', () => {
  const changes = [change('a', '第一章 日常', 5), change('b', '第二章 恢复', 6)];
  for (const candidate of changes) candidate.left.text += '（夜班）';
  const notes = parseNotes('原文：２４\n修改稿：１２\n上下文：夜班\n章节：第二章');
  const result = assessNotes(notes, changes)['note-1'];
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.ids, ['b']);
  assert.equal(notes[0].before, '２４');
  assert.equal(notes[0].after, '１２');
  assert.equal(result.passages['["b"]'].left[0].text, '恢复时长 24 小时（夜班）');
});

test('candidates with the same local context and location remain for manual review', () => {
  const changes = [change('a', '恢复', 5), change('b', '恢复', 6)];
  for (const candidate of changes) candidate.left.text += '（夜班）';
  const notes = parseNotes('原文：24\n修改稿：12\n上下文：夜班\n章节：恢复');
  const result = assessNotes(notes, changes)['note-1'];
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.candidates, [['a'], ['b']]);
  assert.equal(result.ambiguous, true);
});
