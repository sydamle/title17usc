import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { TocData, TocTitle, TocChapter, TocSection, SectionData, ContentBlock, NoteBlock, SectionsMap } from './types';
import tocJsonImport from './data/toc.json';

// TOC imported at build time for instant render
const tocData = tocJsonImport as TocData;

// ======== Per-title data fetching ========

const titleCache = new Map<string, SectionsMap>();
const titlePromises = new Map<string, Promise<SectionsMap>>();

function fetchTitle(titleNum: string): Promise<SectionsMap> {
  if (titleCache.has(titleNum)) return Promise.resolve(titleCache.get(titleNum)!);
  if (titlePromises.has(titleNum)) return titlePromises.get(titleNum)!;
  const p = fetch(`./data/t${titleNum}.json`)
    .then(r => {
      if (!r.ok) throw new Error(`Title ${titleNum} not found`);
      return r.json() as Promise<SectionsMap>;
    })
    .then(data => {
      titleCache.set(titleNum, data);
      return data;
    });
  titlePromises.set(titleNum, p);
  return p;
}

function useTitleSections(titleNum: string): SectionsMap | null | 'error' {
  const [sections, setSections] = useState<SectionsMap | null | 'error'>(
    titleCache.get(titleNum) ?? null,
  );
  useEffect(() => {
    setSections(titleCache.get(titleNum) ?? null);
    fetchTitle(titleNum)
      .then(setSections)
      .catch(() => setSections('error'));
  }, [titleNum]);
  return sections;
}

// ======== Utility ========

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part,
      )}
    </>
  );
}

// ======== Paragraph tools helpers (same as title17usc) ========

const STRUCTURAL_TYPES = new Set([
  'subsection', 'paragraph', 'subparagraph', 'clause', 'subclause', 'item', 'subitem',
]);

function splitBlockHtml(html: string): { numText: string; restHtml: string } | null {
  const m = html.match(/^(<span class="num">)(.*?)(<\/span>)([\s\S]*)$/);
  if (!m) return null;
  return { numText: m[2], restHtml: m[4] };
}

function buildParaMetaMap(
  blocks: ContentBlock[],
  sectionNum: string,
): Map<number, { path: string; id: string }> {
  const map = new Map<number, { path: string; id: string }>();
  const stack: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!STRUCTURAL_TYPES.has(block.type)) continue;
    const m = block.html.match(/<span class="num">(.*?)<\/span>/);
    if (!m) continue;
    const num = m[1];
    const depth = block.indent - 1;
    stack.length = depth;
    stack[depth] = num;
    const path = stack.slice(0, depth + 1).join('');
    const id = `p-${sectionNum}${path}`;
    map.set(i, { path, id });
  }
  return map;
}

// ======== § 101 / definition-section helpers ========

interface Sec101Def {
  slug: string;
  term: string;
  innerHtml: string;
  indentClass: string;
}

function parseSec101Defs(html: string): Sec101Def[] {
  const defs: Sec101Def[] = [];
  const re = /<p class="(indent\d+)">([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const indentClass = m[1];
    const innerHtml = m[2];
    if (indentClass === 'indent1') {
      const termMatch = innerHtml.match(/\u201c([^""\u201d]+)\u201d/);
      const term = termMatch ? termMatch[1] : '';
      const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      defs.push({ slug, term, innerHtml, indentClass });
    } else {
      defs.push({ slug: '', term: '', innerHtml, indentClass });
    }
  }
  return defs;
}

function splitAtFirstTerm(
  html: string,
  term: string,
): { before: string; after: string } | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\u201c${escaped}\u201d)`);
  const idx = html.search(re);
  if (idx === -1) return null;
  const match = html.match(re);
  if (!match) return null;
  const end = idx + match[0].length;
  return { before: html.slice(0, idx), after: html.slice(end) };
}

// ======== Popup ========

interface PopupState {
  id: string;
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
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCite, setCopiedCite] = useState(false);

  function copyText(text: string, which: 'url' | 'cite') {
    const set = which === 'url' ? setCopiedUrl : setCopiedCite;
    const write = navigator.clipboard?.writeText(text);
    if (write) {
      write.then(() => { set(true); setTimeout(() => set(false), 2000); });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      set(true);
      setTimeout(() => set(false), 2000);
    }
  }

  return (
    <div className="para-popup" role="region" aria-label="Paragraph tools">
      <div className="para-popup-header">
        <span>Paragraph tools</span>
        <button className="para-popup-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="para-popup-body">
        <div className="para-popup-row">
          <span className="para-popup-label">URL</span>
          <span className="para-popup-value">{url}</span>
          <button
            className={`para-popup-copy-btn${copiedUrl ? ' copied' : ''}`}
            onClick={() => copyText(url, 'url')}
          >
            {copiedUrl ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div className="para-popup-row">
          <span className="para-popup-label">Citation</span>
          <span className="para-popup-value">{citation}</span>
          <button
            className={`para-popup-copy-btn${copiedCite ? ' copied' : ''}`}
            onClick={() => copyText(citation, 'cite')}
          >
            {copiedCite ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ======== Notes panel ========

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

function NotesPanel({ notes }: { notes: NoteBlock[] }) {
  const rendered: { heading: string; isHeader: boolean; html: string }[] = [];
  let pendingHeader = '';

  for (const note of notes) {
    const heading = note.heading || TOPIC_HEADING[note.topic] || '';
    if (!note.html) {
      pendingHeader = heading;
    } else {
      rendered.push({ heading: pendingHeader || heading, isHeader: !!pendingHeader, html: note.html });
      pendingHeader = '';
    }
  }
  if (pendingHeader) {
    rendered.push({ heading: pendingHeader, isHeader: false, html: '' });
  }

  return (
    <div className="notes-panel">
      {rendered.map((item, i) => (
        <div key={i} className="note-section">
          {item.heading && (
            <h3 className={`note-heading${item.isHeader ? ' note-heading-group' : ''}`}>
              {item.heading}
            </h3>
          )}
          {item.html && (
            <div className="note-body" dangerouslySetInnerHTML={{ __html: item.html }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ======== Sidebar ========

type ViewState =
  | { type: 'home' }
  | { type: 'title'; titleNum: string }
  | { type: 'section'; titleNum: string; sectionNum: string; paragraphAnchor?: string };

interface SidebarProps {
  view: ViewState;
  onNavigate: (v: ViewState) => void;
}

function Sidebar({ view, onNavigate }: SidebarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine which title is "active" for tree expansion
  const activeTitleNum = view.type !== 'home' ? view.titleNum : null;
  const activeTitle = activeTitleNum
    ? tocData.titles.find(t => t.number === activeTitleNum)
    : null;

  // Search results
  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    const results: { titleNum: string; titleName: string; section: TocSection }[] = [];
    for (const title of tocData.titles) {
      for (const ch of title.chapters) {
        for (const sec of ch.sections) {
          if (
            sec.heading.toLowerCase().includes(q) ||
            sec.number.toLowerCase().includes(q) ||
            `${title.number} usc ${sec.number}`.includes(q)
          ) {
            results.push({ titleNum: title.number, titleName: title.name, section: sec });
            if (results.length >= 60) return results;
          }
        }
      }
    }
    return results;
  }, [query]);

  return (
    <nav className="sidebar" aria-label="Navigation">
      <div className="sidebar-search">
        <input
          ref={inputRef}
          type="search"
          className="sidebar-search-input"
          placeholder="Search sections…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search sections"
        />
      </div>

      <div className="sidebar-content">
        {searchResults ? (
          // Search results
          <div className="sidebar-search-results">
            {searchResults.length === 0 ? (
              <div className="sidebar-empty">No results</div>
            ) : (
              searchResults.map((r, i) => (
                <button
                  key={i}
                  className="sidebar-search-result"
                  onClick={() => {
                    onNavigate({ type: 'section', titleNum: r.titleNum, sectionNum: r.section.number });
                    setQuery('');
                  }}
                >
                  <span className="result-num">{r.titleNum} U.S.C. § {r.section.number}</span>
                  <span className="result-heading">
                    {highlightText(r.section.heading, query)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : activeTitle ? (
          // Title tree: chapters + sections
          <>
            <button
              className="sidebar-back-btn"
              onClick={() => onNavigate({ type: 'home' })}
            >
              ← All Titles
            </button>
            <div className="sidebar-title-label">
              Title {activeTitle.number} — {activeTitle.name}
            </div>
            {activeTitle.chapters.map(ch => {
              const activeSec =
                view.type === 'section'
                  ? ch.sections.find(s => s.number === view.sectionNum)
                  : null;
              return (
                <div key={ch.number} className="sidebar-chapter">
                  <div className="sidebar-chapter-heading">
                    Ch. {ch.number}: {ch.heading}
                  </div>
                  {ch.sections.map(sec => (
                    <button
                      key={sec.number}
                      className={`sidebar-section-btn${activeSec?.number === sec.number ? ' active' : ''}`}
                      onClick={() =>
                        onNavigate({
                          type: 'section',
                          titleNum: activeTitle.number,
                          sectionNum: sec.number,
                        })
                      }
                    >
                      <span className="sidebar-sec-num">{sec.numText}</span>
                      <span className="sidebar-sec-heading">{sec.heading}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </>
        ) : (
          // Title list
          tocData.titles.map(title => (
            <button
              key={title.number}
              className="sidebar-title-btn"
              onClick={() => onNavigate({ type: 'title', titleNum: title.number })}
            >
              <span className="sidebar-title-num">Title {title.number}</span>
              <span className="sidebar-title-name">{title.name}</span>
            </button>
          ))
        )}
      </div>
    </nav>
  );
}

// ======== Breadcrumb ========

function Breadcrumb({
  onNavigate,
  title,
  section,
}: {
  onNavigate: (v: ViewState) => void;
  title?: TocTitle;
  chapter?: TocChapter;
  section?: TocSection;
}) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <button className="bc-link" onClick={() => onNavigate({ type: 'home' })}>
        U.S. Code
      </button>
      {title && (
        <>
          <span className="bc-sep">/</span>
          <button
            className="bc-link"
            onClick={() => onNavigate({ type: 'title', titleNum: title.number })}
          >
            Title {title.number}
          </button>
        </>
      )}
      {section && (
        <>
          <span className="bc-sep">/</span>
          <span className="bc-current">§ {section.number}</span>
        </>
      )}
    </nav>
  );
}

// ======== Home page (title list) ========

function HomePage({ onNavigate }: { onNavigate: (v: ViewState) => void }) {
  return (
    <div className="home-view">
      <h1 className="home-title">United States Code</h1>
      <p className="home-subtitle">
        {tocData.titles.length} titles · Release point {tocData.releasePoint} · Updated{' '}
        {tocData.updated}
      </p>
      <div className="title-grid">
        {tocData.titles.map(t => {
          const sectionCount = t.chapters.reduce((n, ch) => n + ch.sections.length, 0);
          return (
            <button
              key={t.number}
              className="title-card"
              onClick={() => onNavigate({ type: 'title', titleNum: t.number })}
            >
              <span className="title-card-num">Title {t.number}</span>
              <span className="title-card-name">{t.name}</span>
              <span className="title-card-meta">
                {t.chapters.length} ch · {sectionCount} §§
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ======== Title page (chapter list) ========

function TitleView({
  titleNum,
  onNavigate,
}: {
  titleNum: string;
  onNavigate: (v: ViewState) => void;
}) {
  const title = tocData.titles.find(t => t.number === titleNum);
  if (!title) return <div className="error-msg">Title {titleNum} not found.</div>;

  const totalSections = title.chapters.reduce((n, ch) => n + ch.sections.length, 0);

  return (
    <>
      <Breadcrumb onNavigate={onNavigate} title={title} />
      <div className="title-view">
        <div className="title-view-header">
          <div className="title-view-num">Title {title.number}</div>
          <h1 className="title-view-name">{title.name}</h1>
          <p className="title-view-meta">
            {title.chapters.length} chapters · {totalSections} sections
          </p>
        </div>
        {title.chapters.map(ch => (
          <div key={ch.number} className="chapter-card">
            <div className="chapter-card-heading">
              Chapter {ch.number} — {ch.heading}
            </div>
            <div className="chapter-card-sections">
              {ch.sections.map(sec => (
                <button
                  key={sec.number}
                  className="chapter-section-btn"
                  onClick={() =>
                    onNavigate({ type: 'section', titleNum, sectionNum: sec.number })
                  }
                >
                  <span className="chapter-sec-num">{sec.numText}</span>
                  <span className="chapter-sec-heading">{sec.heading}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ======== Section view ========

function SectionView({
  titleNum,
  sectionNum,
  paragraphAnchor,
  onNavigate,
}: {
  titleNum: string;
  sectionNum: string;
  paragraphAnchor?: string;
  onNavigate: (v: ViewState) => void;
}) {
  const sections = useTitleSections(titleNum);
  const [activePopup, setActivePopup] = useState<PopupState | null>(null);
  const [activeTab, setActiveTab] = useState<'text' | 'notes'>('text');

  useEffect(() => {
    setActivePopup(null);
    setActiveTab('text');
  }, [titleNum, sectionNum]);

  const tocTitle = tocData.titles.find(t => t.number === titleNum);
  let tocChapter: TocChapter | undefined;
  let tocSection: TocSection | undefined;
  const allSections = tocTitle?.chapters.flatMap(ch => ch.sections) ?? [];
  const sectionIndex = allSections.findIndex(s => s.number === sectionNum);

  for (const ch of tocTitle?.chapters ?? []) {
    const found = ch.sections.find(s => s.number === sectionNum);
    if (found) { tocChapter = ch; tocSection = found; break; }
  }

  const prevSection = sectionIndex > 0 ? allSections[sectionIndex - 1] : null;
  const nextSection = sectionIndex < allSections.length - 1 ? allSections[sectionIndex + 1] : null;

  const section: SectionData | undefined =
    sections && sections !== 'error' ? sections[sectionNum] : undefined;

  // Paragraph metadata for structural blocks (all sections except special cases)
  const isSpecialDefs =
    titleNum === '17' && sectionNum === '101';
  const paraMetaMap = useMemo(
    () =>
      section && !isSpecialDefs
        ? buildParaMetaMap(section.content, sectionNum)
        : new Map<number, { path: string; id: string }>(),
    [section, sectionNum, isSpecialDefs],
  );

  // § 101 definitions (Title 17 only)
  const sec101Defs = useMemo(
    () =>
      isSpecialDefs && section
        ? parseSec101Defs(section.content[0]?.html ?? '')
        : [],
    [section, isSpecialDefs],
  );

  // Scroll to anchor
  useEffect(() => {
    if (!section || !paragraphAnchor) return;
    const id = paragraphAnchor.startsWith('def/')
      ? `def-${sectionNum}-${paragraphAnchor.slice(4)}`
      : `p-${sectionNum}${paragraphAnchor}`;
    const timer = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    return () => clearTimeout(timer);
  }, [section, sectionNum, paragraphAnchor]);

  if (sections === null) {
    return (
      <>
        <Breadcrumb
          
          onNavigate={onNavigate}
          title={tocTitle}
          section={tocSection}
        />
        <div className="loading">Loading title {titleNum}…</div>
      </>
    );
  }

  if (sections === 'error') {
    return (
      <>
        <Breadcrumb
          
          onNavigate={onNavigate}
          title={tocTitle}
          section={tocSection}
        />
        <div className="error-msg">
          Title {titleNum} data is not available yet. Run the parser to generate it.
        </div>
      </>
    );
  }

  if (!section) {
    return (
      <>
        <Breadcrumb
          
          onNavigate={onNavigate}
          title={tocTitle}
          section={tocSection}
        />
        <div className="error-msg">Section {sectionNum} not found in Title {titleNum}.</div>
      </>
    );
  }

  return (
    <>
      <Breadcrumb
        
        onNavigate={onNavigate}
        title={tocTitle}
        chapter={tocChapter}
        section={tocSection}
      />
      <div className="section-view">
        {/* Prev / Next nav */}
        <div className="section-nav-bar">
          <div className="section-nav-links">
            <button
              className="nav-btn"
              disabled={!prevSection}
              onClick={() =>
                prevSection &&
                onNavigate({ type: 'section', titleNum, sectionNum: prevSection.number })
              }
              title={prevSection ? `§ ${prevSection.number} — ${prevSection.heading}` : undefined}
            >
              ← Previous
            </button>
            <button
              className="nav-btn"
              disabled={!nextSection}
              onClick={() =>
                nextSection &&
                onNavigate({ type: 'section', titleNum, sectionNum: nextSection.number })
              }
              title={nextSection ? `§ ${nextSection.number} — ${nextSection.heading}` : undefined}
            >
              Next →
            </button>
          </div>
          {tocChapter && (
            <div className="section-chapter-label">
              <button
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => onNavigate({ type: 'title', titleNum })}
              >
                <span style={{ color: '#005ea2' }}>
                  Chapter {tocChapter.number}: {tocChapter.heading}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Header */}
        <div className="section-header">
          <div className="section-number-label">{titleNum} U.S.C. § {section.number}</div>
          <h1 className="section-heading">{section.heading || `Section ${section.number}`}</h1>
        </div>

        {/* Tabs */}
        <div className="section-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'text'}
            className={`section-tab${activeTab === 'text' ? ' active' : ''}`}
            onClick={() => setActiveTab('text')}
          >
            Text
          </button>
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

        {/* Notes tab */}
        {activeTab === 'notes' && <NotesPanel notes={section.notes} />}

        {/* Text tab */}
        <div className="statutory-text" hidden={activeTab === 'notes'}>
          {section.content.length === 0 ? (
            <p style={{ color: '#767676', fontStyle: 'italic' }}>[Repealed or text omitted]</p>
          ) : isSpecialDefs && sec101Defs.length > 0 ? (
            // Title 17 § 101: definition list
            sec101Defs.map((def, i) => {
              const popupId = `def-${sectionNum}-${def.slug}`;
              const isActive = activePopup?.id === popupId;
              if (def.term && def.slug) {
                const split = splitAtFirstTerm(def.innerHtml, def.term);
                if (split) {
                  const url =
                    `${window.location.origin}${window.location.pathname}` +
                    `#t${titleNum}/s${sectionNum}/def/${def.slug}`;
                  const citation = `${titleNum} U.S.C. § ${sectionNum} "${def.term}"`;
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
              return (
                <p
                  key={i}
                  className={`sec101-def ${def.indentClass}`}
                  dangerouslySetInnerHTML={{ __html: def.innerHtml }}
                />
              );
            })
          ) : (
            // All other sections
            section.content.map((block, i) => {
              const indentLevel = Math.min(block.indent, 6);
              const className = [
                'usc-block',
                `usc-indent-${indentLevel}`,
                block.type === 'continuation' ? 'usc-continuation' : '',
              ]
                .filter(Boolean)
                .join(' ');

              const meta = paraMetaMap.get(i);
              if (meta) {
                const split = splitBlockHtml(block.html);
                if (split) {
                  const isActive = activePopup?.id === String(i);
                  const paraUrl =
                    `${window.location.origin}${window.location.pathname}` +
                    `#t${titleNum}/s${sectionNum}${meta.path}`;
                  const citation = `${titleNum} U.S.C. § ${sectionNum}${meta.path}`;
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
                        <span dangerouslySetInnerHTML={{ __html: split.restHtml }} />
                      </div>
                    </React.Fragment>
                  );
                }
              }

              return (
                <div
                  key={i}
                  className={className}
                  dangerouslySetInnerHTML={{ __html: block.html }}
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

  // #t17/s101/def/anonymous-work
  const defMatch = h.match(/^t(\d+[A-Z]*)\/s(\d+[A-Z]*)\/def\/(.+)$/);
  if (defMatch) {
    return {
      type: 'section',
      titleNum: defMatch[1],
      sectionNum: defMatch[2],
      paragraphAnchor: `def/${defMatch[3]}`,
    };
  }

  // #t17/s101(a)(1)
  const secParenMatch = h.match(/^t(\d+[A-Z]*)\/s(\d+[A-Z]*)(\(.+)$/);
  if (secParenMatch) {
    return {
      type: 'section',
      titleNum: secParenMatch[1],
      sectionNum: secParenMatch[2],
      paragraphAnchor: secParenMatch[3],
    };
  }

  // #t17/s101
  const secMatch = h.match(/^t(\d+[A-Z]*)\/s(\d+[A-Z]*)$/);
  if (secMatch) {
    return { type: 'section', titleNum: secMatch[1], sectionNum: secMatch[2] };
  }

  // #t17
  const titleMatch = h.match(/^t(\d+[A-Z]*)$/);
  if (titleMatch) {
    return { type: 'title', titleNum: titleMatch[1] };
  }

  return { type: 'home' };
}

function viewToHash(view: ViewState): string {
  if (view.type === 'home') return '#';
  if (view.type === 'title') return `#t${view.titleNum}`;
  const anchor = view.paragraphAnchor
    ? view.paragraphAnchor.startsWith('def/')
      ? `/${view.paragraphAnchor}`
      : view.paragraphAnchor
    : '';
  return `#t${view.titleNum}/s${view.sectionNum}${anchor}`;
}

// ======== App root ========

export default function App() {
  const [view, setView] = useState<ViewState>(() => parseHash(window.location.hash));

  const navigate = useCallback((v: ViewState) => {
    setView(v);
    window.history.pushState(null, '', viewToHash(v));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setView(parseHash(window.location.hash));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Prefetch current title's section data in background
  useEffect(() => {
    if (view.type !== 'home') {
      const num = view.titleNum;
      const timer = setTimeout(() => fetchTitle(num), 400);
      return () => clearTimeout(timer);
    }
  }, [view]);

  return (
    <div className="app-layout">
      <header className="top-bar">
        <button className="top-bar-logo" onClick={() => navigate({ type: 'home' })}>
          United States Code
        </button>
      </header>
      <div className="app-body">
        <Sidebar view={view} onNavigate={navigate} />
        <main className="main-content">
          {view.type === 'home' && <HomePage onNavigate={navigate} />}
          {view.type === 'title' && (
            <TitleView titleNum={view.titleNum} onNavigate={navigate} />
          )}
          {view.type === 'section' && (
            <SectionView
              titleNum={view.titleNum}
              sectionNum={view.sectionNum}
              paragraphAnchor={view.paragraphAnchor}
              onNavigate={navigate}
            />
          )}
        </main>
      </div>
    </div>
  );
}
