import { useState, useEffect, useCallback, useRef } from 'react';
import { TocData, TocChapter, TocSection, SectionData, SectionsMap } from './types';
import tocJsonImport from './data/toc.json';

// TOC is small (32KB) — import directly for instant sidebar render
const tocData = tocJsonImport as TocData;

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

// ======== Types for view state ========

type ViewState =
  | { type: 'home' }
  | { type: 'chapter'; chapterNum: string }
  | { type: 'section'; sectionNum: string };

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

// ======== Section View ========

function SectionView({
  sectionNum,
  onNavigate,
}: {
  sectionNum: string;
  onNavigate: (v: ViewState) => void;
}) {
  const sections = useSections();

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

  const section: SectionData | undefined = sections[sectionNum];

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

        <div className="statutory-text">
          {section.content.length === 0 ? (
            <p style={{ color: '#767676', fontStyle: 'italic' }}>
              [Repealed or text omitted]
            </p>
          ) : (
            section.content.map((block, i) => {
              const indentLevel = Math.min(block.indent, 6);
              const className = [
                'usc-block',
                `usc-indent-${indentLevel}`,
                block.type === 'continuation' ? 'usc-continuation' : '',
              ]
                .filter(Boolean)
                .join(' ');

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
  if (h.startsWith('section/'))
    return { type: 'section', sectionNum: h.slice('section/'.length) };
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
              onNavigate={navigate}
            />
          )}
        </main>
      </div>
    </div>
  );
}
