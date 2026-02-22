export interface TocSection {
  number: string;
  numText: string;
  heading: string;
  identifier: string;
}

export interface TocChapter {
  number: string;
  heading: string;
  identifier: string;
  sections: TocSection[];
}

export interface TocData {
  number: string;
  heading: string;
  version: string;
  updated: string;
  chapters: TocChapter[];
}

export interface ContentBlock {
  type: string;
  indent: number;
  html: string;
}

export interface SectionData {
  number: string;
  numText: string;
  heading: string;
  identifier: string;
  content: ContentBlock[];
  sourceCredit: string;
}

export interface SectionsMap {
  [key: string]: SectionData;
}
