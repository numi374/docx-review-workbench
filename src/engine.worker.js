import { initialize, docxDiffCompare, getRevisions, convertDocxToHtml, getComments, getWasmExports } from 'docxodus/core';
import { normalizeDocxText } from './upstream/engine/normalizeText';
import { tagRedline } from './upstream/engine/tagRedline';

let ready;
self.addEventListener('message', async ({ data: { original, edited, notes, appBaseUrl, notesOnly } }) => {
  try {
    self.postMessage({ stage: '正在加载本地 Docxodus 引擎…' });
    ready ??= initialize(new URL('wasm/', appBaseUrl).href).then(() => {
      const result = getWasmExports().DocumentComparer.Warmup();
      if (result !== 'ok') throw new Error(result);
    });
    try {
      await ready;
    } catch (error) {
      ready = undefined;
      throw error;
    }
    if (notesOnly) {
      self.postMessage({ description: await convertDocxToHtml(notes) });
      return;
    }
    if (!original) return;
    const start = performance.now();
    self.postMessage({ stage: '正在本机解析和比较 DOCX…' });
    const left = normalizeDocxText(new Uint8Array(await original.arrayBuffer()));
    const right = normalizeDocxText(new Uint8Array(await edited.arrayBuffer()));
    const existing = { left: await getComments(left), right: await getComments(right) };
    const redline = await docxDiffCompare(left, right, {
      preAcceptInputRevisions: true,
      compareHeadersFooters: false,
      trackNumberingChanges: false,
      detectMoves: true,
    });
    const revisions = await getRevisions(redline);
    self.postMessage({ stage: '正在渲染修改和定位锚点…' });
    const tagged = tagRedline(redline, revisions);
    const html = await convertDocxToHtml(tagged.bytes, {
      renderTrackedChanges: true,
      renderFootnotesAndEndnotes: true,
      renderMoveOperations: true,
      stampAnchors: true,
    });
    const duration = Math.round(performance.now() - start);
    let description = null;
    if (notes?.name.toLowerCase().endsWith('.docx')) {
      description = await convertDocxToHtml(notes);
    }
    self.postMessage({ html, revisions, untagged: tagged.missingKeys.length, existing, description, duration });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
