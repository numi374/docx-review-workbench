const lines = (value) => String(value ?? '').split(/\r?\n/);
const quoted = (value) => lines(value).map((line) => '> ' + line).join('\n');
const oneLine = (value) => lines(value).join(' ').trim();

export function annotationSuggestion(note) {
  return [...new Set([note.suggestion, note.suggestedAction]
    .map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean))].join('\n');
}

export function makeFeedback({ projectName, originalName, baseName, revisedName, roundNumber, date, annotations }) {
  const out = [
    '# Codex 二校反馈报告', '', '## 项目信息', '',
    '- 项目名称：' + oneLine(projectName), '- 原始文档名称：' + oneLine(originalName),
    '- 本轮对比基准：' + oneLine(baseName), '- 当前二校版本：第 ' + roundNumber + ' 轮 · ' + oneLine(revisedName),
    '- 反馈日期：' + date, '', '## 问题列表', '',
  ];
  for (const [index, note] of annotations.entries()) {
    out.push('### 问题 ' + (index + 1), '');
    for (const [label, value] of [['批注编号', note.number], ['位置', note.location], ['所属文档', note.fileName]]) {
      const text = oneLine(value);
      if (text) out.push('**' + label + '：** ' + text, '');
    }
    for (const [label, value] of [
      ['选中文字', note.quote], ['原文', note.before], ['二校内容', note.after], ['Codex 原修改原因', note.reason],
      ['人工复核意见', note.comment], ['建议处理方式', annotationSuggestion(note)],
    ]) {
      if (value?.trim()) out.push('**' + label + '：**', '', quoted(value), '');
    }
    if (note.needsLocation) out.push('**定位状态：** 待重新定位。所列位置及引文来自上一轮，请在当前稿核对。', '');
  }
  out.push('## 反馈总要求', '', '请根据上述人工意见重新检查并修改文档。', '',
    '- 优先处理列出的问题。', '- 不要擅自修改没有问题的内容。', '- 保留原文档的格式。',
    '- 修改完成后生成新的 DOCX 文件。', '- 同时生成本轮修改说明。', '');
  return out.join('\n');
}
