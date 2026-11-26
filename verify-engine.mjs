import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  initialize, convertDocxToHtml, getRevisions, getComments, docxDiffCompare,
  openDocxSession, createExternalAnnotationSet, createAnnotationFromSearch,
  validateExternalAnnotations, convertDocxToHtmlWithExternalAnnotations, CommentRenderMode,
} from 'docxodus/core';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node verify-engine.mjs before.docx after.docx');
const before = await readFile(beforePath);
const after = await readFile(afterPath);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalHash = digest(before);
const start = performance.now();
await initialize();
console.log('Node WASM initialization:', Math.round(performance.now() - start), 'ms');
const options = { preAcceptInputRevisions: true, compareHeadersFooters: false, trackNumberingChanges: false };
const first = await docxDiffCompare(before, after, options);
const second = await docxDiffCompare(before, after, options);
const revisions = await getRevisions(first);
assert(revisions.length > 0);
assert.equal(digest(first), digest(second));
assert.deepEqual(revisions.map((r) => r.id), (await getRevisions(second)).map((r) => r.id));
console.log('Deterministic tracked revisions:', revisions.length, [...new Set(revisions.map((r) => r.family))]);

const html = await convertDocxToHtml(before, {
  commentRenderMode: CommentRenderMode.Inline, renderHeadersAndFooters: true,
  renderFootnotesAndEndnotes: true, stampAnchors: true, semanticLists: true,
});
assert.match(html, /data-anchor=/);
assert.match(html, /<h1\b/);
assert.match(html, /<table\b/);
assert.match(html, /(?:<strong\b|font-weight:\s*bold)/i);
assert.match(html, /(?:<em\b|font-style:\s*italic)/i);
assert.match(html, /<(?:ul|ol)\b/);
assert(html.includes('质量审核部'));
assert(html.includes('请核对恢复目标'));
const existing = await getComments(before);
assert.equal(existing.length, 1);
console.log('Native comment:', existing[0].author, existing[0].text ?? existing[0].markdown);

const session = openDocxSession(before);
try {
  const hit = session.grep('该系统')[0];
  assert(hit);
  const result = session.addComment(hit.enclosingAnchor.id, hit.span, '复核', '新建 Word 评论');
  assert(result.success, JSON.stringify(result));
  const newComments = await getComments(session.save());
  assert.equal(newComments.length, 2);
  console.log('Native addComment and save: passed');
} finally {
  session.close();
}

const set = await createExternalAnnotationSet(before, 'before');
set.textLabels.test = { id: 'test', text: '复核', color: '#fcd56b', description: '', icon: '', labelType: 'text' };
const external = createAnnotationFromSearch('example', 'test', set.content, '该系统');
assert(external);
set.labelledText.push(external);
assert((await validateExternalAnnotations(before, set)).isValid);
assert((await validateExternalAnnotations(after, set)).hashMismatch);
const externalHtml = await convertDocxToHtmlWithExternalAnnotations(before, set);
assert(externalHtml.includes('ext-annot-'));
assert.equal(digest(before), originalHash);
console.log('External annotation, hash mismatch and byte preservation: passed');
