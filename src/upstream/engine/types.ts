// Selected revision types from docx-diff/src/engine/types.ts.
export interface AnchorRef {
  id: string;
  kind: string;
  scope: string;
  unid: string;
}

export interface RevisionListEntry {
  id: string;
  type: 'insert' | 'delete' | 'move' | 'format' | 'structure';
  family: string;
  constituentKeys: string[];
  text: string;
  partUri: string;
  scope: string;
  anchorId?: string;
  affectedAnchors: AnchorRef[];
  resolutionStatus: 'supported' | 'unsupported' | 'malformed' | 'ambiguous';
}
