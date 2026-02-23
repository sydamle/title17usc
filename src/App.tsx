import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TocData, TocChapter, TocSection, SectionData, ContentBlock, SectionsMap, NoteBlock } from './types';
import tocJsonImport from './data/toc.json';

// TOC is small (32KB) — import directly for instant sidebar render
const tocData = tocJsonImport as TocData;

// ======== Data types ========

export interface LegHistoryEntry {
  citation: string;       // "H.R. Rep. No. 94-1476"
  shortTitle: string;     // brief description of the report
  congress: number;
  year: number;
  publaw: string;         // "94-553" — the enacting public law
  govinfoPkg: string;     // govinfo.gov package ID, e.g. "CRPT-94hrpt1476"
  pages?: string;         // page range in the report
  html: string;           // HTML excerpt
}

// ======== Data fetching ========

let sectionsCache: SectionsMap | null = null;
let sectionsPromise: Promise<SectionsMap> | null = null;

function fetchSections(): Promise<SectionsMap> {
  if (sectionsCache) return Promise.resolve(sectionsCache);
  if (sectionsPromise) return sectionsPromise;
  sectionsPromise = fetch('./data/sections.json')
    .then(r => r.json())
    .then((data: SectionsMap) => {
      sectionsCache = data;
      return data;
    });
  return sectionsPromise;
}

function useSections(): SectionsMap | null {
  const [sections, setSections] = useState<SectionsMap | null>(sectionsCache);
  useEffect(() => {
    if (!sectionsCache) {
      fetchSections().then(setSections);
    }
  }, []);
  return sections;
}

type LegHistoryMap = Record<string, LegHistoryEntry[]>;
let legHistoryCache: LegHistoryMap | null = null;
let legHistoryPromise: Promise<LegHistoryMap> | null = null;

function fetchLegHistory(): Promise<LegHistoryMap> {
  if (legHistoryCache) return Promise.resolve(legHistoryCache);
  if (legHistoryPromise) return legHistoryPromise;
  legHistoryPromise = fetch('./data/leg-history.json')
    .then(r => r.json())
    .then((data: LegHistoryMap) => {
      legHistoryCache = data;
      return data;
    });
  return legHistoryPromise;
}

function useLegHistory(sectionNum: string): LegHistoryEntry[] {
  const [entries, setEntries] = useState<LegHistoryEntry[]>(
    legHistoryCache?.[sectionNum] ?? [],
  );
  useEffect(() => {
    fetchLegHistory().then(data => setEntries(data[sectionNum] ?? []));
  }, [sectionNum]);
  return entries;
}

// ======== Utility ========

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i}>{part}</mark>
          : part
      )}
    </>
  );
}

// ======== Paragraph tool helpers ========

// Block types that correspond to structural subdivisions in the USC
const STRUCTURAL_TYPES = new Set([
  'subsection', 'paragraph', 'subparagraph', 'clause', 'subclause', 'item', 'subitem',
]);

// Extract the text inside <span class="num">...</span> and everything after it
function splitBlockHtml(html: string): { numText: string; restHtml: string } | null {
  const m = html.match(/^<span class="num">([^<]*)<\/span>([\s\S]*)/);
  if (!m) return null;
  return { numText: m[1], restHtml: m[2] };
}

// Build a map of block-index → { path, id } for all structural blocks in a section.
// "path" is the concatenated designators from root to this block, e.g. "(b)(1)".
function buildParaMetaMap(
  content: ContentBlock[],
  sectionNum: string,
): Map<number, { path: string; id: string }> {
  const map = new Map<number, { path: string; id: string }>();
  const stack: Array<{ indent: number; numText: string }> = [];
  content.forEach((block, i) => {
    if (!STRUCTURAL_TYPES.has(block.type)) return;
    const split = splitBlockHtml(block.html);
    if (!split) return;
    // Pop any stack entries at the same or deeper indent level
    while (stack.length > 0 && stack[stack.length - 1].indent >= block.indent) {
      stack.pop();
    }
    stack.push({ indent: block.indent, numText: split.numText.trim() });
    const path = stack.map(e => e.numText).join(''); // e.g., "(b)(1)"
    map.set(i, { path, id: `p-${sectionNum}${path}` });
  });
  return map;
}

// ======== Section 101 definition helpers ========

interface Sec101Def {
  indentClass: string;   // e.g. "indent0", "indent1", "indent2"
  innerHtml: string;     // HTML content inside the <p> tag
  term: string | null;   // the defined term (without quotes), e.g. "anonymous work"
  slug: string | null;   // URL-safe slug, e.g. "anonymous-work"
}

// Parse the monolithic section 101 HTML into individual paragraph objects.
function parseSec101Defs(html: string): Sec101Def[] {
  const result: Sec101Def[] = [];
  const pRegex = /<p class="(indent\d+)">([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(html)) !== null) {
    const indentClass = m[1];
    const innerHtml = m[2];
    let term: string | null = null;
    let slug: string | null = null;
    // Only top-level definition paragraphs get a term badge
    if (indentClass === 'indent1') {
      // The XML uses Unicode curly quotes \u201C…\u201D, not ASCII "
      const tm = innerHtml.match(/\u201c([^\u201d]+)\u201d/);
      if (tm) {
        term = tm[1];
        slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      }
    }
    result.push({ indentClass, innerHtml, term, slug });
  }
  return result;
}

// Split a definition's inner HTML at the first occurrence of "term",
// returning the text before and after (with quotes consumed).
function splitAtFirstTerm(
  html: string,
  term: string,
): { before: string; after: string } | null {
  const target = `\u201c${term}\u201d`; // curly quotes: "term"
  const idx = html.indexOf(target);
  if (idx === -1) return null;
  return { before: html.slice(0, idx), after: html.slice(idx + target.length) };
}

// ======== Term Annotation ========
// Annotates defined terms from §§ 101 and 115(e) in statutory text.
// Uses a single-pass regex (terms sorted longest-first) so overlapping
// definitions from different sources never double-wrap the same text.

interface TermDef {
  term: string;
  slug: string;
  source: string; // '101' | '115e'
}

function buildTermAnnotator(termDefs: TermDef[]): (html: string) => string {
  const terms = termDefs
    .filter(d => d.term && d.slug)
    .sort((a, b) => b.term.length - a.term.length); // longest-first avoids partial matches
  if (terms.length === 0) return html => html;

  const infoByLower = new Map(
    terms.map(t => [t.term.toLowerCase(), { slug: t.slug, source: t.source }]),
  );
  const pattern = terms
    .map(t => {
      const esc = t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return esc.replace(/ /g, '\\s+');
    })
    .join('|');
  const termRe = new RegExp(`\\b(${pattern})\\b`, 'gi');

  return function annotate(html: string): string {
    const parts = html.split(/(<[^>]+>)/g);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) return part; // HTML tag — leave unchanged
        return part.replace(termRe, match => {
          const info = infoByLower.get(match.toLowerCase());
          return info
            ? `<span class="def-term" data-slug="${info.slug}" data-def-source="${info.source}">${match}</span>`
            : match;
        });
      })
      .join('');
  };
}

// Collect the full definition HTML for a § 101 slug.
function getFullDefHtml(defs: Sec101Def[], slug: string): string {
  const idx = defs.findIndex(d => d.slug === slug);
  if (idx === -1) return '';
  const parts: string[] = [];
  for (let i = idx; i < defs.length; i++) {
    if (i > idx && defs[i].indentClass === 'indent1') break;
    parts.push(`<p class="def-popup-para ${defs[i].indentClass}">${defs[i].innerHtml}</p>`);
  }
  return parts.join('');
}

// ======== § 115(e) Definition Helpers ========

interface Sec115eDef {
  blockIndex: number; // index in section.content of the top-level definition block
  term: string;
  slug: string;
  anchor: string; // paragraph anchor for navigation, e.g. "(e)(1)"
  indent: number; // indent level of the definition block (2 for § 115(e))
}

// Parse the definitions from subsection (e) of § 115 out of the section's
// content block array.  Each indent=2 paragraph inside subsection (e) that
// carries a curly-quoted term becomes a Sec115eDef.
function parseSec115eDefs(content: ContentBlock[]): Sec115eDef[] {
  const defs: Sec115eDef[] = [];
  let inE = false;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === 'subsection' && /class="num">\(e\)/.test(block.html)) {
      inE = true;
      continue;
    }
    if (inE && block.type === 'subsection' && block.indent <= 1) break; // next subsection
    if (!inE) continue;

    if (block.indent === 2) {
      const termMatch = block.html.match(/\u201c([^\u201d]+)\u201d/);
      if (termMatch) {
        const term = termMatch[1];
        const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const numMatch = block.html.match(/^<span class="num">([^<]+)<\/span>/);
        const designator = numMatch ? numMatch[1].trim() : '';
        defs.push({ blockIndex: i, term, slug, anchor: `(e)${designator}`, indent: 2 });
      }
    }
  }
  return defs;
}

// Build the popup HTML for a § 115(e) definition: the top-level block plus
// any deeper-indent sub-blocks that belong to it.
function getSec115eDefHtml(content: ContentBlock[], def: Sec115eDef): string {
  const parts: string[] = [];
  for (let i = def.blockIndex; i < content.length; i++) {
    const block = content[i];
    if (i > def.blockIndex && block.indent <= def.indent) break;
    const relPad = (block.indent - def.indent) * 24;
    parts.push(
      `<div class="def-popup-block" style="padding-left:${relPad}px">${block.html}</div>`,
    );
  }
  return parts.join('');
}

// ======== Paragraph Popup ========

interface PopupState {
  id: string;   // String(blockIndex) for structural blocks; "def-101-{slug}" for definitions
  url: string;
  citation: string;
}

function ParagraphPopup({
  url,
  citation,
  onClose,
}: {
  url: string;
  citation: string;
  onClose: () => void;
}) {
  const [urlCopied, setUrlCopied] = useState(false);
  const [citCopied, setCitCopied] = useState(false);

  const copy = async (text: string, setFlag: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setFlag(true);
      setTimeout(() => setFlag(false), 2000);
    }
  };

  return (
    <div className="para-popup" role="region" aria-label="Paragraph tools">
      <div className="para-popup-header">
        <span>Paragraph Tools</span>
        <button className="para-popup-close" onClick={onClose} aria-label="Close paragraph tools">
          ×
        </button>
      </div>
      <div className="para-popup-body">
        <div className="para-popup-row">
          <span className="para-popup-label">URL</span>
          <span className="para-popup-value">{url}</span>
          <button
            className={`para-popup-copy-btn${urlCopied ? ' copied' : ''}`}
            onClick={() => copy(url, setUrlCopied)}
          >
            {urlCopied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div className="para-popup-row">
          <span className="para-popup-label">Citation</span>
          <span className="para-popup-value">{citation}</span>
          <button
            className={`para-popup-copy-btn${citCopied ? ' copied' : ''}`}
            onClick={() => copy(citation, setCitCopied)}
          >
            {citCopied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ======== Definition Term Popup ========

interface DefPopupState {
  slug: string;
  term: string;
  defHtml: string;
  label: string;       // e.g. "§\u202f101" or "§\u202f115(e)"
  navTarget: ViewState;
  x: number;
  y: number;
}

function DefTermPopup({
  popup,
  onClose,
  onNavigate,
}: {
  popup: DefPopupState;
  onClose: () => void;
  onNavigate: (v: ViewState) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const left = Math.max(8, Math.min(popup.x - 20, window.innerWidth - 508));
  const top = popup.y + 16;

  return (
    <div
      ref={ref}
      className="def-popup"
      style={{ position: 'fixed', left, top, zIndex: 300 }}
      role="dialog"
      aria-label={`Definition of ${popup.term}`}
    >
      <div className="def-popup-header">
        <span>{'\u201c'}{popup.term}{'\u201d'}</span>
        <span className="def-popup-tag">{popup.label}</span>
        <button className="def-popup-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="def-popup-body" dangerouslySetInnerHTML={{ __html: popup.defHtml }} />
      <div className="def-popup-footer">
        <button
          className="def-popup-goto"
          onClick={() => { onNavigate(popup.navTarget); onClose(); }}
        >
          View full definition in {popup.label} →
        </button>
      </div>
    </div>
  );
}

// ======== Types for view state ========

type ViewState =
  | { type: 'home' }
  | { type: 'chapter'; chapterNum: string }
  | { type: 'section'; sectionNum: string; paragraphAnchor?: string };

// ======== Sidebar ========

interface SidebarProps {
  view: ViewState;
  onNavigate: (view: ViewState) => void;
}

function Sidebar({ view, onNavigate }: SidebarProps) {
  const [search, setSearch] = useState('');
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => {
    if (view.type === 'section') {
      for (const ch of tocData.chapters) {
        if (ch.sections.some(s => s.number === (view as { type: 'section'; sectionNum: string }).sectionNum)) {
          return new Set([ch.number]);
        }
      }
    }
    if (view.type === 'chapter') {
      return new Set([(view as { type: 'chapter'; chapterNum: string }).chapterNum]);
    }
    return new Set<string>();
  });

  const activeSectionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (view.type === 'section') {
      const sectionNum = (view as { type: 'section'; sectionNum: string }).sectionNum;
      for (const ch of tocData.chapters) {
        if (ch.sections.some(s => s.number === sectionNum)) {
          setOpenChapters(prev => new Set([...prev, ch.number]));
          break;
        }
      }
    }
  }, [view]);

  useEffect(() => {
    if (activeSectionRef.current) {
      activeSectionRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [view]);

  const toggleChapter = useCallback((num: string) => {
    setOpenChapters(prev => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  }, []);

  const lowerSearch = search.toLowerCase().trim();

  const filteredChapters = lowerSearch
    ? tocData.chapters
        .map(ch => ({
          ...ch,
          sections: ch.sections.filter(
            s =>
              s.heading.toLowerCase().includes(lowerSearch) ||
              s.number.toLowerCase().includes(lowerSearch)
          ),
        }))
        .filter(
          ch =>
            ch.sections.length > 0 || ch.heading.toLowerCase().includes(lowerSearch)
        )
    : tocData.chapters;

  const activeSectionNum =
    view.type === 'section'
      ? (view as { type: 'section'; sectionNum: string }).sectionNum
      : null;
  const activeChapterNum =
    view.type === 'chapter'
      ? (view as { type: 'chapter'; chapterNum: string }).chapterNum
      : view.type === 'section'
      ? (() => {
          const sNum = (view as { type: 'section'; sectionNum: string }).sectionNum;
          for (const ch of tocData.chapters) {
            if (ch.sections.some(s => s.number === sNum)) return ch.number;
          }
          return null;
        })()
      : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button
          className="sidebar-title-link"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            width: '100%',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          onClick={() => onNavigate({ type: 'home' })}
        >
          Title 17 — Copyrights
        </button>
        <div className="sidebar-search-wrapper">
          <input
            className="sidebar-search"
            type="text"
            placeholder="Search sections..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search sections"
          />
          {search && (
            <button
              className="sidebar-search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Table of Contents">
        {filteredChapters.length === 0 && (
          <div className="no-results">No sections found.</div>
        )}
        {filteredChapters.map(ch => {
          const isOpen = lowerSearch
            ? ch.sections.length > 0
            : openChapters.has(ch.number);
          const isActiveChapter = ch.number === activeChapterNum;

          return (
            <div key={ch.number} className="toc-chapter">
              <button
                className={`toc-chapter-btn${isActiveChapter ? ' active' : ''}`}
                onClick={() => {
                  if (!lowerSearch) toggleChapter(ch.number);
                  else onNavigate({ type: 'chapter', chapterNum: ch.number });
                }}
                aria-expanded={isOpen}
              >
                <span className={`toc-chapter-chevron${isOpen ? ' open' : ''}`}>▶</span>
                <span className="toc-chapter-label">
                  <span className="toc-chapter-num">Chapter {ch.number}</span>
                  <span className="toc-chapter-name">
                    {lowerSearch ? highlightText(ch.heading, search) : ch.heading}
                  </span>
                </span>
              </button>

              {isOpen && (
                <ul className="toc-section-list" role="list">
                  {ch.sections.map(s => {
                    const isActive = s.number === activeSectionNum;
                    return (
                      <li key={s.number} className="toc-section-item">
                        <button
                          ref={isActive ? activeSectionRef : null}
                          className={`toc-section-btn${isActive ? ' active' : ''}`}
                          onClick={() =>
                            onNavigate({ type: 'section', sectionNum: s.number })
                          }
                          aria-current={isActive ? 'page' : undefined}
                        >
                          <span className="toc-section-num">§ {s.number}</span>
                          {lowerSearch ? highlightText(s.heading, search) : s.heading}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

// ======== Breadcrumb ========

interface BreadcrumbProps {
  view: ViewState;
  onNavigate: (view: ViewState) => void;
  chapter?: TocChapter;
  section?: TocSection;
}

function Breadcrumb({ view, onNavigate, chapter, section }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <button
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        onClick={() => onNavigate({ type: 'home' })}
      >
        <span style={{ color: '#005ea2' }}>Title 17</span>
      </button>
      {chapter && (
        <>
          <span className="breadcrumb-sep">›</span>
          {view.type === 'chapter' ? (
            <span className="breadcrumb-current">Chapter {chapter.number}</span>
          ) : (
            <button
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              onClick={() =>
                onNavigate({ type: 'chapter', chapterNum: chapter.number })
              }
            >
              <span style={{ color: '#005ea2' }}>Chapter {chapter.number}</span>
            </button>
          )}
        </>
      )}
      {section && view.type === 'section' && (
        <>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-current">§ {section.number}</span>
        </>
      )}
    </nav>
  );
}

// ======== Home Page ========

function HomePage({ onNavigate }: { onNavigate: (v: ViewState) => void }) {
  const totalSections = tocData.chapters.reduce((n, c) => n + c.sections.length, 0);
  const versionStr = tocData.version
    .replace('Online@', '')
    .replace('not', ', except P.L. ');

  return (
    <>
      <Breadcrumb view={{ type: 'home' }} onNavigate={onNavigate} />
      <div className="home-page">
        <p className="home-eyebrow">United States Code</p>
        <h1 className="home-heading">Title 17 — Copyrights</h1>
        <div className="home-meta">
          <span>Current through P.L. {versionStr}</span>
          <span>·</span>
          <span>Updated {tocData.updated}</span>
          <span>·</span>
          <span>
            {tocData.chapters.length} Chapters · {totalSections} Sections
          </span>
        </div>

        <h2 className="home-chapters-heading">Chapters</h2>
        {tocData.chapters.map(ch => (
          <div
            key={ch.number}
            className="chapter-card"
            onClick={() => onNavigate({ type: 'chapter', chapterNum: ch.number })}
          >
            <div className="chapter-card-header">
              <span className="chapter-card-num">Chapter {ch.number}</span>
              <span className="chapter-card-title">{ch.heading}</span>
              <span className="chapter-card-arrow">
                §§ {ch.sections[0]?.number}–
                {ch.sections[ch.sections.length - 1]?.number} ›
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ======== Chapter View ========

function ChapterView({
  chapter,
  onNavigate,
}: {
  chapter: TocChapter;
  onNavigate: (v: ViewState) => void;
}) {
  return (
    <>
      <Breadcrumb
        view={{ type: 'chapter', chapterNum: chapter.number }}
        onNavigate={onNavigate}
        chapter={chapter}
      />
      <div className="chapter-view">
        <p className="chapter-view-eyebrow">Chapter {chapter.number}</p>
        <h1 className="chapter-view-heading">{chapter.heading}</h1>
        <ul className="chapter-section-list">
          {chapter.sections.map(s => (
            <li key={s.number} className="chapter-section-item">
              <div
                className="chapter-section-link"
                onClick={() =>
                  onNavigate({ type: 'section', sectionNum: s.number })
                }
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ')
                    onNavigate({ type: 'section', sectionNum: s.number });
                }}
              >
                <span className="chapter-section-num">§ {s.number}</span>
                <span className="chapter-section-title">{s.heading}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ======== Notes Panel ========

const TOPIC_HEADING: Record<string, string> = {
  historicalAndRevision: 'Historical and Revision Notes',
  amendments: 'Amendments',
  effectiveDateOfAmendment: 'Effective Date of Amendment',
  editorialNotes: 'Editorial Notes',
  statutoryNotes: 'Statutory Notes',
  referencesInText: 'References in Text',
  shortTitleOfAmendment: 'Short Title',
  effectiveDate: 'Effective Date',
  priorProvisions: 'Prior Provisions',
  separability: 'Separability',
  execDoc: 'Executive Document',
  removalDescription: 'Removal Description',
  definitions: 'Definitions',
  savings: 'Savings Provisions',
  constitutionality: 'Constitutionality',
  codification: 'Codification',
  executiveOrder: 'Executive Order',
};

// ======== Pub. L. → Committee Reports mapping ========
// Maps "congress-lawnum" keys (e.g. "94-553") to the committee reports
// associated with that public law.  govinfoPkg is the govinfo.gov package ID
// used to build the details-page URL.

interface ReportRef {
  citation: string;   // "H.R. Rep. No. 94-1476"
  body: string;       // "House" | "Senate" | "Conference"
  govinfoPkg: string; // "CRPT-94hrpt1476"
}

const PUB_LAW_REPORTS: Record<string, ReportRef[]> = {
  '94-553': [   // Copyright Act of 1976
    { citation: 'H.R. Rep. No. 94-1476', body: 'House',      govinfoPkg: 'CRPT-94hrpt1476' },
    { citation: 'S. Rep. No. 94-473',    body: 'Senate',     govinfoPkg: 'CRPT-94srpt473'  },
    { citation: 'H.R. Rep. No. 94-1733', body: 'Conference', govinfoPkg: 'CRPT-94hrpt1733' },
  ],
  '96-517': [   // Computer Software Copyright Act of 1980
    { citation: 'H.R. Rep. No. 96-1307', body: 'House', govinfoPkg: 'CRPT-96hrpt1307' },
  ],
  '100-568': [  // Berne Convention Implementation Act of 1988
    { citation: 'H.R. Rep. No. 100-609', body: 'House',  govinfoPkg: 'CRPT-100hrpt609' },
    { citation: 'S. Rep. No. 100-352',   body: 'Senate', govinfoPkg: 'CRPT-100srpt352'  },
  ],
  '101-650': [  // Judicial Improvements Act of 1990 (incl. VARA, Architectural Works)
    { citation: 'H.R. Rep. No. 101-735', body: 'House', govinfoPkg: 'CRPT-101hrpt735' },
  ],
  '102-307': [  // Copyright Amendments Act of 1992 (renewal)
    { citation: 'H.R. Rep. No. 102-379', body: 'House', govinfoPkg: 'CRPT-102hrpt379' },
  ],
  '102-563': [  // Audio Home Recording Act of 1992
    { citation: 'S. Rep. No. 102-294',   body: 'Senate', govinfoPkg: 'CRPT-102srpt294'  },
    { citation: 'H.R. Rep. No. 102-873', body: 'House',  govinfoPkg: 'CRPT-102hrpt873' },
  ],
  '103-465': [  // Uruguay Round Agreements Act (§ 104A restored works)
    { citation: 'H.R. Rep. No. 103-826', body: 'House', govinfoPkg: 'CRPT-103hrpt826' },
  ],
  '104-39': [   // Digital Performance Right in Sound Recordings Act of 1995
    { citation: 'S. Rep. No. 104-128', body: 'Senate', govinfoPkg: 'CRPT-104srpt128' },
  ],
  '105-80': [   // No Electronic Theft Act of 1997
    { citation: 'H.R. Rep. No. 105-339', body: 'House', govinfoPkg: 'CRPT-105hrpt339' },
  ],
  '105-298': [  // Sonny Bono Copyright Term Extension Act
    { citation: 'H.R. Rep. No. 105-452', body: 'House', govinfoPkg: 'CRPT-105hrpt452' },
  ],
  '105-304': [  // Digital Millennium Copyright Act (DMCA)
    { citation: 'H.R. Rep. No. 105-551 (Pt.\u00a01)', body: 'House',      govinfoPkg: 'CRPT-105hrpt551pt1' },
    { citation: 'H.R. Rep. No. 105-551 (Pt.\u00a02)', body: 'House',      govinfoPkg: 'CRPT-105hrpt551pt2' },
    { citation: 'S. Rep. No. 105-190',               body: 'Senate',     govinfoPkg: 'CRPT-105srpt190'    },
    { citation: 'H.R. Rep. No. 105-796',             body: 'Conference', govinfoPkg: 'CRPT-105hrpt796'    },
  ],
  '107-273': [  // 21st Century Department of Justice Appropriations Act (TEACH Act, § 13301)
    { citation: 'H.R. Rep. No. 107-687', body: 'House', govinfoPkg: 'CRPT-107hrpt687' },
  ],
  '108-419': [  // Copyright Royalty and Distribution Reform Act of 2004
    { citation: 'S. Rep. No. 108-144', body: 'Senate', govinfoPkg: 'CRPT-108srpt144' },
  ],
  '110-403': [  // PRO-IP Act of 2008
    { citation: 'H.R. Rep. No. 110-617', body: 'House', govinfoPkg: 'CRPT-110hrpt617' },
  ],
  '111-295': [  // Copyright Cleanup, Clarification, and Corrections Act of 2010
    { citation: 'H.R. Rep. No. 111-669', body: 'House', govinfoPkg: 'CRPT-111hrpt669' },
  ],
  '115-264': [  // Music Modernization Act
    { citation: 'H.R. Rep. No. 115-651', body: 'House',  govinfoPkg: 'CRPT-115hrpt651' },
    { citation: 'S. Rep. No. 115-339',   body: 'Senate', govinfoPkg: 'CRPT-115srpt339' },
  ],
  '116-260': [  // Consolidated Appropriations Act, 2021 (CASE Act — Div. Q)
    { citation: 'H.R. Rep. No. 116-252', body: 'House', govinfoPkg: 'CRPT-116hrpt252' },
  ],
};

// Parse all "Congress-LawNum" pairs out of a sourceCredit string.
// sourceCredit uses en-dashes (–), not hyphens.
function extractPubLaws(sourceCredit: string): string[] {
  const seen = new Set<string>();
  const re = /Pub\.\s*L\.\s*(\d+)[–\-](\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceCredit)) !== null) {
    seen.add(`${m[1]}-${m[2]}`);
  }
  return [...seen];
}

// Return all ReportRef entries relevant to a sourceCredit string.
function reportsForSourceCredit(sourceCredit: string): ReportRef[] {
  return extractPubLaws(sourceCredit).flatMap(pl => PUB_LAW_REPORTS[pl] ?? []);
}

// ======== Reports Panel (Notes tab footer) ========

function ReportsPanel({ sourceCredit }: { sourceCredit: string }) {
  const reports = useMemo(() => reportsForSourceCredit(sourceCredit), [sourceCredit]);
  if (reports.length === 0) return null;
  return (
    <div className="reports-panel">
      <h3 className="reports-panel-heading">Committee Reports</h3>
      <ul className="reports-panel-list">
        {reports.map((r, i) => (
          <li key={i} className="reports-panel-item">
            <a
              href={`https://www.govinfo.gov/app/details/${r.govinfoPkg}`}
              target="_blank"
              rel="noopener noreferrer"
              className="reports-panel-link"
            >
              {r.citation}
            </a>
            <span className="reports-panel-body">{r.body}</span>
          </li>
        ))}
      </ul>
      <p className="reports-panel-note">
        Links open the govinfo.gov details page for each report, which provides
        access to PDF and HTML versions.
      </p>
    </div>
  );
}

// ======== Sections with curated legislative history ========
const HISTORY_SECTIONS = new Set([
  '101', '102', '106', '107', '108', '109', '110', '114', '115', '117', '512', '1201',
]);

// ======== History Panel ========

function HistoryPanel({ entries }: { entries: LegHistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="history-panel">
        <p className="history-empty">No curated legislative history available for this section.</p>
      </div>
    );
  }
  return (
    <div className="history-panel">
      {entries.map((entry, i) => (
        <div key={i} className="history-entry">
          <div className="history-entry-header">
            <div className="history-entry-meta">
              <span className="history-entry-citation">{entry.citation}</span>
              {entry.pages && (
                <span className="history-entry-pages">pp.\u00a0{entry.pages}</span>
              )}
              <span className="history-entry-year">({entry.year})</span>
            </div>
            <div className="history-entry-title">{entry.shortTitle}</div>
            <a
              href={`https://www.govinfo.gov/app/details/${entry.govinfoPkg}`}
              target="_blank"
              rel="noopener noreferrer"
              className="history-entry-govinfo"
            >
              Full report on govinfo.gov ↗
            </a>
          </div>
          <div
            className="history-entry-body"
            dangerouslySetInnerHTML={{ __html: entry.html }}
          />
        </div>
      ))}
      <p className="history-disclaimer">
        Excerpts are drawn from publicly available committee reports and are provided for
        research purposes. Report text is in the public domain. Page citations refer to
        the printed committee report; pagination may vary across reprinted versions.
      </p>
    </div>
  );
}

// ======== USLM link resolver ========
// Converts USLM identifiers (e.g. /us/pl/106/113, /us/usc/t17/s101) to real
// URLs, and handles in-app navigation for Title 17 cross-references.

function handleUslmClick(
  e: React.MouseEvent,
  onNavigate: (v: ViewState) => void,
) {
  const anchor = (e.target as Element).closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href || !href.startsWith('/us/')) return;

  e.preventDefault();

  // Title 17 US Code cross-reference: /us/usc/t17/s801[...]
  const uscMatch = href.match(/^\/us\/usc\/t17\/s(\d+[A-Z0-9]*)/i);
  if (uscMatch) {
    onNavigate({ type: 'section', sectionNum: uscMatch[1] });
    return;
  }

  // Public Law: /us/pl/{congress}/{law}[/section-parts]
  const plMatch = href.match(/^\/us\/pl\/(\d+)\/(\d+)/);
  if (plMatch) {
    window.open(
      `https://www.govinfo.gov/link/plaw/${plMatch[1]}/public/${plMatch[2]}`,
      '_blank',
      'noopener,noreferrer',
    );
    return;
  }

  // Statutes at Large: /us/stat/{volume}/{page}
  const statMatch = href.match(/^\/us\/stat\/(\d+)\/(\d+)/);
  if (statMatch) {
    window.open(
      `https://www.govinfo.gov/link/statute/${statMatch[1]}/${statMatch[2]}`,
      '_blank',
      'noopener,noreferrer',
    );
    return;
  }

  // Other USC titles and historical acts: no in-app navigation available;
  // prevent broken relative-path navigation.
}

function NotesPanel({ notes, onNavigate }: { notes: NoteBlock[]; onNavigate: (v: ViewState) => void }) {
  // Merge consecutive heading-only notes into the next note with content,
  // so "Historical and Revision Notes" acts as a section header.
  const rendered: { heading: string; isHeader: boolean; html: string }[] = [];
  let pendingHeader = '';

  for (const note of notes) {
    const heading = note.heading || TOPIC_HEADING[note.topic] || '';
    if (!note.html) {
      // No body — treat as a section header label for the next note(s)
      pendingHeader = heading;
    } else {
      rendered.push({
        heading: pendingHeader || heading,
        isHeader: !!pendingHeader,
        html: note.html,
      });
      pendingHeader = '';
    }
  }
  // If there's a pending header with no following body, still show it
  if (pendingHeader) {
    rendered.push({ heading: pendingHeader, isHeader: false, html: '' });
  }

  return (
    <div className="notes-panel" onClick={e => handleUslmClick(e, onNavigate)}>
      {rendered.map((item, i) => (
        <div key={i} className="note-section">
          {item.heading && (
            <h3 className={`note-heading${item.isHeader ? ' note-heading-group' : ''}`}>
              {item.heading}
            </h3>
          )}
          {item.html && (
            <div
              className="note-body"
              dangerouslySetInnerHTML={{ __html: item.html }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ======== Section View ========

function SectionView({
  sectionNum,
  paragraphAnchor,
  onNavigate,
}: {
  sectionNum: string;
  paragraphAnchor?: string;
  onNavigate: (v: ViewState) => void;
}) {
  const sections = useSections();
  const [activePopup, setActivePopup] = useState<PopupState | null>(null);
  const [activeTab, setActiveTab] = useState<'text' | 'history' | 'notes'>('text');
  const [activeDefPopup, setActiveDefPopup] = useState<DefPopupState | null>(null);
  const hasHistory = HISTORY_SECTIONS.has(sectionNum);
  const legHistory = useLegHistory(sectionNum);

  // Reset popup and tab when navigating to a different section
  useEffect(() => {
    setActivePopup(null);
    setActiveTab('text');
    setActiveDefPopup(null);
  }, [sectionNum]);

  let chapter: TocChapter | undefined;
  let tocSection: TocSection | undefined;
  const allSections = tocData.chapters.flatMap(ch => ch.sections);
  const sectionIndex = allSections.findIndex(s => s.number === sectionNum);

  for (const ch of tocData.chapters) {
    const found = ch.sections.find(s => s.number === sectionNum);
    if (found) {
      chapter = ch;
      tocSection = found;
      break;
    }
  }

  const prevSection = sectionIndex > 0 ? allSections[sectionIndex - 1] : null;
  const nextSection =
    sectionIndex < allSections.length - 1 ? allSections[sectionIndex + 1] : null;

  const section: SectionData | undefined = sections?.[sectionNum];

  // Build paragraph metadata map for all sections except § 101 (which has its own definition tools)
  const paraMetaMap = useMemo(
    () =>
      section && sectionNum !== '101'
        ? buildParaMetaMap(section.content, sectionNum)
        : new Map<number, { path: string; id: string }>(),
    [section, sectionNum],
  );

  // Parse section 101 definitions (only for § 101)
  const sec101Defs = useMemo(
    () =>
      sectionNum === '101' && section
        ? parseSec101Defs(section.content[0]?.html ?? '')
        : [],
    [section, sectionNum],
  );

  // For non-§101 sections: parse § 101 defs to power term highlighting
  const defs101 = useMemo(
    () =>
      sectionNum !== '101' && sections?.['101']
        ? parseSec101Defs(sections['101'].content[0]?.html ?? '')
        : [],
    [sections, sectionNum],
  );

  // For § 115: also parse subsection (e) inline definitions
  const sec115eDefs = useMemo(
    () => sectionNum === '115' && section ? parseSec115eDefs(section.content) : [],
    [section, sectionNum],
  );

  // Build a single combined annotator (longest-first across both sources)
  // so § 115(e) terms and § 101 terms never double-wrap the same span.
  const annotateTerms = useMemo(() => {
    const termDefs: TermDef[] = [];
    for (const d of defs101) {
      if (d.term && d.slug) termDefs.push({ term: d.term, slug: d.slug, source: '101' });
    }
    for (const d of sec115eDefs) {
      termDefs.push({ term: d.term, slug: d.slug, source: '115e' });
    }
    return buildTermAnnotator(termDefs);
  }, [defs101, sec115eDefs]);

  // Handle clicks on highlighted defined terms
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const span = (e.target as Element).closest('.def-term');
      if (span) {
        const slug = span.getAttribute('data-slug');
        const defSource = span.getAttribute('data-def-source');
        if (slug) {
          if (defSource === '115e') {
            const def = sec115eDefs.find(d => d.slug === slug);
            if (def) {
              setActiveDefPopup({
                slug,
                term: def.term,
                defHtml: getSec115eDefHtml(section!.content, def),
                label: '\u00a7\u202f115(e)',
                navTarget: { type: 'section', sectionNum: '115', paragraphAnchor: def.anchor },
                x: e.clientX,
                y: e.clientY,
              });
              return;
            }
          } else {
            const def = defs101.find(d => d.slug === slug);
            if (def?.term) {
              setActiveDefPopup({
                slug,
                term: def.term,
                defHtml: getFullDefHtml(defs101, slug),
                label: '\u00a7\u202f101',
                navTarget: { type: 'section', sectionNum: '101', paragraphAnchor: `def/${slug}` },
                x: e.clientX,
                y: e.clientY,
              });
              return;
            }
          }
        }
      }
      handleUslmClick(e, onNavigate);
    },
    [defs101, sec115eDefs, section, onNavigate],
  );

  // Scroll to the paragraph/definition anchor once content is ready
  useEffect(() => {
    if (!section || !paragraphAnchor) return;
    // Definition anchor: "def/anonymous-work" → id "def-101-anonymous-work"
    // Paragraph anchor:  "(a)"              → id "p-701(a)"
    const id = paragraphAnchor.startsWith('def/')
      ? `def-${sectionNum}-${paragraphAnchor.slice(4)}`
      : `p-${sectionNum}${paragraphAnchor}`;
    const timer = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    return () => clearTimeout(timer);
  }, [section, sectionNum, paragraphAnchor]);

  if (!sections) {
    return (
      <>
        <Breadcrumb
          view={{ type: 'section', sectionNum }}
          onNavigate={onNavigate}
          chapter={chapter}
          section={tocSection}
        />
        <div className="loading">Loading section content…</div>
      </>
    );
  }

  if (!section) {
    return (
      <>
        <Breadcrumb
          view={{ type: 'section', sectionNum }}
          onNavigate={onNavigate}
          chapter={chapter}
          section={tocSection}
        />
        <div className="not-found">
          <p>Section {sectionNum} not found.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <Breadcrumb
        view={{ type: 'section', sectionNum }}
        onNavigate={onNavigate}
        chapter={chapter}
        section={tocSection}
      />
      {activeDefPopup && (
        <DefTermPopup
          popup={activeDefPopup}
          onClose={() => setActiveDefPopup(null)}
          onNavigate={onNavigate}
        />
      )}
      <div className="section-view">
        <div className="section-nav-bar">
          <div className="section-nav-links">
            <button
              className="nav-btn"
              disabled={!prevSection}
              onClick={() =>
                prevSection &&
                onNavigate({ type: 'section', sectionNum: prevSection.number })
              }
              title={
                prevSection
                  ? `§ ${prevSection.number} — ${prevSection.heading}`
                  : undefined
              }
            >
              ← Previous
            </button>
            <button
              className="nav-btn"
              disabled={!nextSection}
              onClick={() =>
                nextSection &&
                onNavigate({ type: 'section', sectionNum: nextSection.number })
              }
              title={
                nextSection
                  ? `§ ${nextSection.number} — ${nextSection.heading}`
                  : undefined
              }
            >
              Next →
            </button>
          </div>

          {chapter && (
            <div className="section-chapter-label">
              <button
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() =>
                  onNavigate({ type: 'chapter', chapterNum: chapter!.number })
                }
              >
                <span style={{ color: '#005ea2' }}>
                  Chapter {chapter.number}: {chapter.heading}
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="section-header">
          <div className="section-number-label">17 U.S.C. § {section.number}</div>
          <h1 className="section-heading">
            {section.heading || `Section ${section.number}`}
          </h1>
        </div>

        <div className="section-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'text'}
            className={`section-tab${activeTab === 'text' ? ' active' : ''}`}
            onClick={() => setActiveTab('text')}
          >
            Text
          </button>
          {hasHistory && (
            <button
              role="tab"
              aria-selected={activeTab === 'history'}
              className={`section-tab${activeTab === 'history' ? ' active' : ''}`}
              onClick={() => setActiveTab('history')}
            >
              History{'\u00a0'}(Beta)
            </button>
          )}
          {section.notes.length > 0 && (
            <button
              role="tab"
              aria-selected={activeTab === 'notes'}
              className={`section-tab${activeTab === 'notes' ? ' active' : ''}`}
              onClick={() => setActiveTab('notes')}
            >
              Notes
            </button>
          )}
        </div>

        {activeTab === 'history' ? (
          <HistoryPanel entries={legHistory} />
        ) : null}

        {activeTab === 'notes' ? (
          <>
            <NotesPanel notes={section.notes} onNavigate={onNavigate} />
            {section.sourceCredit && <ReportsPanel sourceCredit={section.sourceCredit} />}
          </>
        ) : null}

        <div
          className="statutory-text"
          hidden={activeTab !== 'text'}
          onClick={handleContentClick}
        >
          {section.content.length === 0 ? (
            <p style={{ color: '#767676', fontStyle: 'italic' }}>
              [Repealed or text omitted]
            </p>
          ) : sectionNum === '101' && sec101Defs.length > 0 ? (
            // ── § 101 Definitions: each paragraph rendered individually ──
            sec101Defs.map((def, i) => {
              const popupId = `def-101-${def.slug}`;
              const isActive = activePopup?.id === popupId;

              if (def.term && def.slug) {
                const split = splitAtFirstTerm(def.innerHtml, def.term);
                if (split) {
                  const url =
                    `${window.location.origin}${window.location.pathname}` +
                    `#section/101/def/${def.slug}`;
                  const citation = `17 U.S.C. § 101 "${def.term}"`;
                  return (
                    <React.Fragment key={i}>
                      {isActive && (
                        <ParagraphPopup
                          url={activePopup!.url}
                          citation={activePopup!.citation}
                          onClose={() => setActivePopup(null)}
                        />
                      )}
                      <p className={`sec101-def ${def.indentClass}`} id={popupId}>
                        <span dangerouslySetInnerHTML={{ __html: split.before }} />
                        <button
                          className={`para-num-btn${isActive ? ' active' : ''}`}
                          onClick={() =>
                            isActive
                              ? setActivePopup(null)
                              : setActivePopup({ id: popupId, url, citation })
                          }
                          aria-expanded={isActive}
                          title={`Paragraph tools for \u201c${def.term}\u201d`}
                        >
                          {'\u201c'}{def.term}{'\u201d'}
                        </button>
                        <span dangerouslySetInnerHTML={{ __html: split.after }} />
                      </p>
                    </React.Fragment>
                  );
                }
              }

              // Non-definition paragraph (indent0 intro, indent2/3 sub-items)
              return (
                <p
                  key={i}
                  className={`sec101-def ${def.indentClass}`}
                  dangerouslySetInnerHTML={{ __html: def.innerHtml }}
                />
              );
            })
          ) : (
            // ── All other sections ──
            section.content.map((block, i) => {
              const indentLevel = Math.min(block.indent, 6);
              const className = [
                'usc-block',
                `usc-indent-${indentLevel}`,
                block.type === 'continuation' ? 'usc-continuation' : '',
              ]
                .filter(Boolean)
                .join(' ');

              // Paragraph-tool-enabled block
              const meta = paraMetaMap.get(i);
              if (meta) {
                const split = splitBlockHtml(block.html);
                if (split) {
                  const isActive = activePopup?.id === String(i);
                  const paraUrl =
                    `${window.location.origin}${window.location.pathname}` +
                    `#section/${sectionNum}${meta.path}`;
                  const citation = `17 U.S.C. § ${sectionNum}${meta.path}`;

                  return (
                    <React.Fragment key={i}>
                      {isActive && (
                        <ParagraphPopup
                          url={activePopup!.url}
                          citation={activePopup!.citation}
                          onClose={() => setActivePopup(null)}
                        />
                      )}
                      <div className={className} id={meta.id}>
                        <button
                          className={`para-num-btn${isActive ? ' active' : ''}`}
                          onClick={() =>
                            isActive
                              ? setActivePopup(null)
                              : setActivePopup({ id: String(i), url: paraUrl, citation })
                          }
                          aria-expanded={isActive}
                          title={`Paragraph tools for ${meta.path}`}
                        >
                          {split.numText}
                        </button>
                        <span dangerouslySetInnerHTML={{ __html: annotateTerms(split.restHtml) }} />
                      </div>
                    </React.Fragment>
                  );
                }
              }

              // Default rendering
              return (
                <div
                  key={i}
                  className={className}
                  dangerouslySetInnerHTML={{ __html: annotateTerms(block.html) }}
                />
              );
            })
          )}

          {section.sourceCredit && (
            <div className="source-credit">
              <span className="source-credit-label">Historical and Statutory Notes</span>
              {section.sourceCredit}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ======== URL / Hash routing ========

function parseHash(hash: string): ViewState {
  const h = hash.replace(/^#\/?/, '');
  if (!h) return { type: 'home' };
  if (h.startsWith('section/')) {
    const rest = h.slice('section/'.length);
    // Definition anchor: "101/def/anonymous-work"
    const defMatch = rest.match(/^(\d+[A-Z]*)\/def\/(.+)$/);
    if (defMatch) {
      return {
        type: 'section',
        sectionNum: defMatch[1],
        paragraphAnchor: `def/${defMatch[2]}`,
      };
    }
    // Paragraph anchor: "701(a)" or "701(b)(1)"
    const parenIdx = rest.indexOf('(');
    if (parenIdx > 0) {
      return {
        type: 'section',
        sectionNum: rest.slice(0, parenIdx),
        paragraphAnchor: rest.slice(parenIdx),
      };
    }
    return { type: 'section', sectionNum: rest };
  }
  if (h.startsWith('chapter/'))
    return { type: 'chapter', chapterNum: h.slice('chapter/'.length) };
  return { type: 'home' };
}

function viewToHash(view: ViewState): string {
  if (view.type === 'section')
    return `#section/${(view as { type: 'section'; sectionNum: string }).sectionNum}`;
  if (view.type === 'chapter')
    return `#chapter/${(view as { type: 'chapter'; chapterNum: string }).chapterNum}`;
  return '#';
}

// ======== Root App ========

export default function App() {
  const [view, setView] = useState<ViewState>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setView(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((newView: ViewState) => {
    window.location.hash = viewToHash(newView);
    setView(newView);
    // Scroll to top of content area
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  // Prefetch sections data in the background after initial render
  useEffect(() => {
    const timer = setTimeout(() => fetchSections(), 800);
    return () => clearTimeout(timer);
  }, []);

  const chapterForView =
    view.type === 'chapter'
      ? tocData.chapters.find(
          ch =>
            ch.number ===
            (view as { type: 'chapter'; chapterNum: string }).chapterNum
        )
      : undefined;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <button
            className="header-logo"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            onClick={() => navigate({ type: 'home' })}
          >
            <div className="header-logo-seal">17</div>
            <div className="header-title-group">
              <span className="header-site-name">U.S. Code</span>
              <span className="header-title">Title 17 — Copyrights</span>
              <span className="header-subtitle">
                Office of the Law Revision Counsel
              </span>
            </div>
          </button>
        </div>
      </header>

      <div className="main-layout">
        <Sidebar view={view} onNavigate={navigate} />

        <main className="content-area">
          {view.type === 'home' && <HomePage onNavigate={navigate} />}
          {view.type === 'chapter' && chapterForView && (
            <ChapterView chapter={chapterForView} onNavigate={navigate} />
          )}
          {view.type === 'chapter' && !chapterForView && (
            <div className="not-found">Chapter not found.</div>
          )}
          {view.type === 'section' && (
            <SectionView
              sectionNum={
                (view as { type: 'section'; sectionNum: string }).sectionNum
              }
              paragraphAnchor={
                (view as { type: 'section'; sectionNum: string; paragraphAnchor?: string })
                  .paragraphAnchor
              }
              onNavigate={navigate}
            />
          )}
        </main>
      </div>
    </div>
  );
}

