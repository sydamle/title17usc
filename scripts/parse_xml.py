#!/usr/bin/env python3
"""
Parse Title 17 USLM XML and generate structured JSON for the website.
Usage: python3 scripts/parse_xml.py <path-to-usc17.xml> <output-dir>

To re-download the XML:
  curl -L \
    -H "User-Agent: Mozilla/5.0" \
    -H "Referer: https://uscode.house.gov/download/download.shtml" \
    "https://uscode.house.gov/download/releasepoints/us/pl/119/73not60/xml_usc17@119-73not60.zip" \
    -o title17.zip && unzip title17.zip
"""

import xml.etree.ElementTree as ET
import json
import sys
import re
from pathlib import Path

NS = 'http://xml.house.gov/schemas/uslm/1.0'

def tag(local):
    return f'{{{NS}}}{local}'

def local_name(el):
    return el.tag.replace(f'{{{NS}}}', '') if el.tag.startswith(f'{{{NS}}}') else el.tag

def escape_html(text):
    if not text:
        return ''
    return (text
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;'))

def inline_to_html(el):
    """Convert an element's mixed content to an HTML string."""
    result = ''
    if el.text:
        result += escape_html(el.text)
    for child in el:
        ln = local_name(child)
        inner = inline_to_html(child)
        if ln == 'ref':
            href = escape_html(child.get('href', ''))
            result += f'<a href="{href}" class="ref">{inner}</a>'
        elif ln == 'date':
            result += f'<span class="date">{inner}</span>'
        elif ln in ('em', 'i'):
            result += f'<em>{inner}</em>'
        elif ln in ('strong', 'b'):
            result += f'<strong>{inner}</strong>'
        elif ln == 'sup':
            result += f'<sup>{inner}</sup>'
        elif ln == 'sub':
            result += f'<sub>{inner}</sub>'
        elif ln == 'term':
            result += f'<dfn>{inner}</dfn>'
        elif ln == 'br':
            result += '<br/>'
        else:
            result += inner
        if child.tail:
            result += escape_html(child.tail)
    return result

def get_full_text(el):
    """Get plain text content of element, stripping all tags."""
    if el is None:
        return ''
    parts = []
    if el.text:
        parts.append(el.text)
    for child in el:
        parts.append(get_full_text(child))
        if child.tail:
            parts.append(child.tail)
    return ''.join(parts)

# USLM structural element types
STRUCTURAL_ELEMENTS = {
    'subsection', 'paragraph', 'subparagraph', 'clause',
    'subclause', 'item', 'subitem', 'subsubitem'
}

# Indentation level for each structural type
INDENT_LEVELS = {
    'section': 0,
    'subsection': 1,
    'paragraph': 2,
    'subparagraph': 3,
    'clause': 4,
    'subclause': 5,
    'item': 6,
    'subitem': 7,
}

def parse_section_to_blocks(section_el):
    """Parse a section element into a flat list of content blocks."""
    blocks = []
    _visit_element(section_el, blocks, depth=0)
    return blocks

def _visit_element(el, blocks, depth):
    """
    Recursively visit an element and emit content blocks.
    depth=0 means section level, depth=1 means subsection, etc.
    """
    el_type = local_name(el)

    # Walk through children in document order
    for child in el:
        ln = local_name(child)

        # Skip non-content elements
        if ln in ('num', 'heading', 'sourceCredit', 'notes', 'toc', 'layout',
                   'header', 'tocItem', 'metadata'):
            continue

        # Handle structural subdivisions recursively
        if ln in STRUCTURAL_ELEMENTS:
            _visit_structural(child, blocks, depth + 1, ln)
            continue

        # Handle block-level text containers at section level
        if ln in ('chapeau', 'content', 'continuation', 'flush'):
            html = _container_to_html(child)
            if html.strip():
                blocks.append({
                    'type': ln,
                    'indent': depth,
                    'html': html,
                })
            continue

        # Handle a raw paragraph
        if ln == 'p':
            html = inline_to_html(child)
            if html.strip():
                cls = child.get('class', '')
                indent = _indent_from_class(cls) if cls else depth
                blocks.append({
                    'type': 'p',
                    'indent': indent,
                    'html': html,
                })
            continue

        # Handle tables
        if ln == 'table':
            html = _table_to_html(child)
            if html.strip():
                blocks.append({
                    'type': 'table',
                    'indent': depth,
                    'html': html,
                })
            continue

def _indent_from_class(cls):
    for i in range(6, -1, -1):
        if f'indent{i}' in cls:
            return i
    return 0

def _visit_structural(el, blocks, depth, el_type):
    """
    Visit a structural element (subsection, paragraph, etc.).
    Emits one block for the intro line, then recurses into children.
    """
    indent = depth  # Use depth counter instead of INDENT_LEVELS

    num_el = el.find(tag('num'))
    heading_el = el.find(tag('heading'))

    num_html = f'<span class="num">{escape_html(num_el.text)}</span>' if num_el is not None and num_el.text else ''
    heading_html = f'<span class="enum-heading">{inline_to_html(heading_el)}</span>' if heading_el is not None else ''

    # Find what holds the main text for this element
    chapeau_el = el.find(tag('chapeau'))
    content_el = el.find(tag('content'))

    if chapeau_el is not None:
        body_html = _container_to_html(chapeau_el)
        intro_html = f'{num_html} {heading_html}{body_html}'.strip()
        if intro_html:
            blocks.append({'type': el_type, 'indent': indent, 'html': intro_html})
        # Recurse into children (structural sub-elements only)
        for child in el:
            ln = local_name(child)
            if ln in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, ln)
        # Handle continuation
        cont_el = el.find(tag('continuation'))
        if cont_el is not None:
            cont_html = _container_to_html(cont_el)
            if cont_html.strip():
                blocks.append({'type': 'continuation', 'indent': indent, 'html': cont_html})

    elif content_el is not None:
        body_html = _container_to_html(content_el)
        intro_html = f'{num_html} {heading_html}{body_html}'.strip()
        if intro_html:
            blocks.append({'type': el_type, 'indent': indent, 'html': intro_html})
        # Recurse into structural children (there shouldn't be any if content_el is set,
        # but handle just in case)
        for child in el:
            ln = local_name(child)
            if ln in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, ln)

    else:
        # No chapeau or content - check for direct structural children or p elements
        # First emit the num+heading as a header block if meaningful
        header_html = f'{num_html} {heading_html}'.strip()

        # Collect all children
        has_structural = any(local_name(c) in STRUCTURAL_ELEMENTS for c in el)
        inline_parts = []
        for child in el:
            ln = local_name(child)
            if ln in ('num', 'heading', 'sourceCredit', 'notes'):
                continue
            if ln in STRUCTURAL_ELEMENTS:
                continue
            if ln == 'p':
                inline_parts.append(inline_to_html(child))
            elif ln not in ('chapeau', 'content'):
                inline_parts.append(inline_to_html(child))

        if inline_parts:
            body_html = ''.join(inline_parts)
            intro_html = f'{num_html} {heading_html}{body_html}'.strip()
            blocks.append({'type': el_type, 'indent': indent, 'html': intro_html})
        elif header_html:
            blocks.append({'type': el_type, 'indent': indent, 'html': header_html})

        # Recurse into structural children
        for child in el:
            ln = local_name(child)
            if ln in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, ln)

def _container_to_html(el):
    """Convert a container element (chapeau, content, etc.) to HTML."""
    result = ''
    if el.text:
        result += escape_html(el.text)
    for child in el:
        ln = local_name(child)
        if ln == 'p':
            inner = inline_to_html(child)
            cls = child.get('class', '')
            result += f'<p class="{cls}">{inner}</p>'
        else:
            result += inline_to_html(child)
        if child.tail:
            result += escape_html(child.tail)
    return result

def _table_to_html(el):
    """Convert a table element to a simple HTML table."""
    rows = []
    for row in el.iter(tag('tr')):
        cells = []
        for cell in row:
            ln = local_name(cell)
            if ln in ('td', 'th'):
                inner = inline_to_html(cell)
                attrs = ''
                colspan = cell.get('colspan', '')
                rowspan = cell.get('rowspan', '')
                if colspan:
                    attrs += f' colspan="{colspan}"'
                if rowspan:
                    attrs += f' rowspan="{rowspan}"'
                cells.append(f'<{ln}{attrs}>{inner}</{ln}>')
        if cells:
            rows.append(f'<tr>{"".join(cells)}</tr>')
    return f'<table class="usc-table">{"".join(rows)}</table>' if rows else ''

def get_source_credit(section_el):
    sc_el = section_el.find(tag('sourceCredit'))
    return get_full_text(sc_el).strip() if sc_el is not None else ''

def _note_to_html(note_el):
    """Convert a <note> element's body (excluding its <heading>) to HTML."""
    parts = []
    for child in note_el:
        ln = local_name(child)
        if ln == 'heading':
            continue
        if ln == 'p':
            inner = inline_to_html(child)
            if inner.strip():
                cls = child.get('class', '')
                if cls:
                    parts.append(f'<p class="{cls}">{inner}</p>')
                else:
                    parts.append(f'<p>{inner}</p>')
        elif ln == 'note':
            # Nested subnote – recurse and wrap in a div
            inner_html = _note_to_html(child)
            sub_heading_el = child.find(tag('heading'))
            sub_heading = get_full_text(sub_heading_el).strip() if sub_heading_el is not None else ''
            if sub_heading:
                parts.append(f'<p class="subnote-heading">{escape_html(sub_heading)}</p>')
            if inner_html:
                parts.append(inner_html)
        else:
            inner = inline_to_html(child)
            if inner.strip():
                parts.append(f'<p>{inner}</p>')
        if child.tail and child.tail.strip():
            parts.append(escape_html(child.tail))
    return ''.join(parts)

def get_notes(section_el):
    """Extract the <notes> element into a list of note dicts."""
    notes_el = section_el.find(tag('notes'))
    if notes_el is None:
        return []

    notes = []
    for note_el in notes_el.findall(tag('note')):
        topic = note_el.get('topic', 'miscellaneous')
        heading_el = note_el.find(tag('heading'))
        heading = get_full_text(heading_el).strip() if heading_el is not None else ''
        html = _note_to_html(note_el)
        # Skip completely empty notes (heading-only historicalAndRevision stubs
        # that have no body text are common; include them so the heading shows)
        notes.append({'topic': topic, 'heading': heading, 'html': html})

    return notes

def parse_section(section_el):
    identifier = section_el.get('identifier', '')
    num_el = section_el.find(tag('num'))
    heading_el = section_el.find(tag('heading'))

    num_val = num_el.get('value', '') if num_el is not None else ''
    num_text = (num_el.text or '') if num_el is not None else ''
    heading_text = get_full_text(heading_el).strip() if heading_el is not None else ''

    content_blocks = parse_section_to_blocks(section_el)
    source_credit = get_source_credit(section_el)
    notes = get_notes(section_el)

    return {
        'number': num_val,
        'numText': num_text,
        'heading': heading_text,
        'identifier': identifier,
        'content': content_blocks,
        'sourceCredit': source_credit,
        'notes': notes,
    }

def parse_chapter(chapter_el):
    identifier = chapter_el.get('identifier', '')
    num_el = chapter_el.find(tag('num'))
    heading_el = chapter_el.find(tag('heading'))

    num_text = (num_el.text or '') if num_el is not None else ''
    heading_text = get_full_text(heading_el).strip() if heading_el is not None else ''

    num_val = num_el.get('value', '') if num_el is not None else ''
    if not num_val:
        m = re.search(r'(\d+)', num_text)
        num_val = m.group(1) if m else num_text

    sections = []
    for child in chapter_el:
        ln = local_name(child)
        if ln == 'section':
            sections.append(parse_section(child))
        elif ln == 'subchapter':
            for gc in child:
                if local_name(gc) == 'section':
                    sections.append(parse_section(gc))

    heading_clean = heading_text.rstrip('—').strip()
    return {
        'number': num_val,
        'heading': heading_clean,
        'identifier': identifier,
        'sections': sections,
    }

def parse_title(xml_path):
    print(f"Parsing {xml_path}...")
    tree = ET.parse(xml_path)
    root = tree.getroot()

    meta = root.find(tag('meta'))
    version = ''
    updated = ''
    if meta is not None:
        doc_pub = meta.find(tag('docPublicationName'))
        created = meta.find('{http://purl.org/dc/terms/}created')
        if doc_pub is not None:
            version = doc_pub.text or ''
        if created is not None:
            updated = (created.text or '').split('T')[0]

    main_el = root.find(tag('main'))
    title_el = main_el.find(tag('title')) if main_el is not None else None
    title_heading = 'COPYRIGHTS'
    if title_el is not None:
        heading_el = title_el.find(tag('heading'))
        if heading_el is not None:
            title_heading = get_full_text(heading_el)

    chapters = []
    if title_el is not None:
        for child in title_el:
            if local_name(child) == 'chapter':
                ch = parse_chapter(child)
                print(f"  Ch {ch['number']}: {ch['heading']} ({len(ch['sections'])} sections)")
                chapters.append(ch)

    return {
        'number': '17',
        'heading': title_heading,
        'version': version,
        'updated': updated,
        'chapters': chapters,
    }

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 parse_xml.py <usc17.xml> <output-dir>")
        sys.exit(1)

    xml_path = sys.argv[1]
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)

    title_data = parse_title(xml_path)

    # TOC (lightweight)
    toc_data = {
        'number': title_data['number'],
        'heading': title_data['heading'],
        'version': title_data['version'],
        'updated': title_data['updated'],
        'chapters': [
            {
                'number': ch['number'],
                'heading': ch['heading'],
                'identifier': ch['identifier'],
                'sections': [
                    {
                        'number': s['number'],
                        'numText': s['numText'],
                        'heading': s['heading'],
                        'identifier': s['identifier'],
                    }
                    for s in ch['sections']
                ]
            }
            for ch in title_data['chapters']
        ]
    }
    toc_path = output_dir / 'toc.json'
    with open(toc_path, 'w', encoding='utf-8') as f:
        json.dump(toc_data, f, ensure_ascii=False, indent=2)
    print(f"\nWrote TOC -> {toc_path}")

    # Individual section files
    sections_dir = output_dir / 'sections'
    sections_dir.mkdir(exist_ok=True)
    section_count = 0
    for ch in title_data['chapters']:
        for s in ch['sections']:
            path = sections_dir / f"section-{s['number']}.json"
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(s, f, ensure_ascii=False, indent=2)
            section_count += 1

    print(f"Wrote {section_count} section files -> {sections_dir}")

    # Combined sections file
    all_sections = {s['number']: s for ch in title_data['chapters'] for s in ch['sections']}
    sections_path = output_dir / 'sections.json'
    with open(sections_path, 'w', encoding='utf-8') as f:
        json.dump(all_sections, f, ensure_ascii=False, indent=2)
    print(f"Wrote combined sections -> {sections_path}")

    total_blocks = sum(len(s['content']) for ch in title_data['chapters'] for s in ch['sections'])
    print(f"\nTotal: {len(title_data['chapters'])} chapters, {section_count} sections, {total_blocks} content blocks")

if __name__ == '__main__':
    main()
