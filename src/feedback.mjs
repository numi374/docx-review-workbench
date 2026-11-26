const lines = (value) => String(value ?? '').split(/\r?\n/);
const quoted = (value, fallback) => lines(value || fallback).map((line) => '> ' + line).join('\n');
const oneLine = (value) => lines(value).join(' ').trim();

export function makeFeedback({ projectName, originalName, baseName, revisedName, roundNumber, date, annotations }) {
  const out = [
    '# Codex 二校反馈报告', '', '## 项目信息', '',
    '- 项目名称：' + oneLine(projectName), '- 原始文档名称：' + oneLine(originalName),
    '- 本轮对比基准：' + oneLine(baseName), '- 当前二校版本：第 ' + roundNumber + ' 轮 · ' + oneLine(revisedName),
    '- 反馈日期：' + date, '', '## 问题列表', '',
  ];
  for (const [index, note] of annotations.entries()) {
    out.push('### 问题 ' + (index + 1), '', '**批注编号：** ' + note.number, '',
      '**位置：** ' + oneLine(note.location), '',
      '**所属文档：** ' + oneLine(note.fileName), '',
      '**选中文字：**', '', quoted(note.quote, '无选区'), '',
      '**原文：**', '', quoted(note.before, '无对应原文段落'), '',
      '**二校内容：**', '', quoted(note.after, '无对应二校段落'), '',
      '**Codex 原修改原因：**', '', quoted(note.reason, '未找到已关联的修改说明'), '',
      '**人工复核意见：**', '', quoted(note.comment, '无'), '',
      '**建议处理方式：**', '', quoted(note.suggestion, '请结合人工复核意见判断并处理。'), '');
    if (note.needsLocation) out.push('**定位状态：** 待重新定位。所列位置及引文来自上一轮，请在当前稿核对。', '');
  }
  out.push('## 反馈总要求', '', '请根据上述人工意见重新检查并修改文档。', '',
    '- 优先处理列出的问题。', '- 不要擅自修改没有问题的内容。', '- 保留原文档的格式。',
    '- 修改完成后生成新的 DOCX 文件。', '- 同时生成本轮修改说明。', '');
  return out.join('\n');
}
