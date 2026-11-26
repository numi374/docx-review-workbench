# docx-diff 来源

这一目录摘自 [docx-diff 9b942f6](https://github.com/docx-diff/docx-diff/tree/9b942f6432e30584bd6fa8a33dcb0fb56aea7025/src)。MIT 版权声明见 `../../licenses/docx-diff-MIT.txt`。

- `engine/normalizeText.ts`、`engine/ooxml.ts`、`engine/tagRedline.ts` 对应上游同名模块。
- `model/changes.ts`、`model/docIndex.ts`、`model/equivalence.ts` 对应上游同名模块。
- `ui/renderedDocument.ts` 对应上游同名模块。
- `ui/scrollMapping.ts` 抽取自 `ui/scrollSync.ts`，保留偏移测量和映射算法。
- `engine/types.ts` 和 `model/paragraphEdit.ts` 保存上述模块使用的类型。
