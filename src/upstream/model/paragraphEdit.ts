// Selected type from docx-diff/src/model/paragraphEdit.ts.
import type { ChangeItem } from './changes';

export type BlockItem = Pick<ChangeItem, 'id' | 'kind' | 'revisionIds' | 'removedText' | 'addedText' | 'wordDelta'> &
  Partial<Pick<ChangeItem, 'text' | 'description'>>;
