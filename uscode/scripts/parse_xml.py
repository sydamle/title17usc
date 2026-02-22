#!/usr/bin/env python3
"""
Parse a single US Code title USLM XML file and generate structured JSON.

Usage:
    python3 scripts/parse_xml.py <path-to-uscNN.xml> <output-dir> [--toc-only]

Outputs:
    <output-dir>/toc-<N>.json      TOC fragment for this title (chapters/sections)
    <output-dir>/t<N>.json         Full section data for this title

To download all titles:
    bash scripts/download_all.sh

Release point URL pattern:
    https://uscode.house.gov/download/releasepoints/us/pl/119/73not60/xml_usc17@119-73not60.zip
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

STRUCTURAL_ELEMENTS = {
    'subsection', 'paragraph', 'subparagraph', 'clause',
    'subclause', 'item', 'subitem', 'subsubitem'
}

def parse_section_to_blocks(section_el):
    blocks = []
    _visit_element(section_el, blocks, depth=0)
    return blocks

def _visit_element(el, blocks, depth):
    for child in el:
        ln = local_name(child)
        if ln in ('num', 'heading', 'sourceCredit', 'notes', 'toc', 'layout',
                   'header', 'tocItem', 'metadata'):
            continue
        if ln in STRUCTURAL_ELEMENTS:
            _visit_structural(child, blocks, depth + 1, ln)
            continue
        if ln in ('chapeau', 'content', 'continuation', 'flush'):
            html = _container_to_html(child)
            if html.strip():
                blocks.append({'type': ln, 'indent': depth, 'html': html})
            continue
        if ln == 'p':
            html = inline_to_html(child)
            if html.strip():
                cls = child.get('class', '')
                indent = _indent_from_class(cls) if cls else depth
                blocks.append({'type': 'p', 'indent': indent, 'html': html})
            continue
        if ln == 'table':
            html = _table_to_html(child)
            if html.strip():
                blocks.append({'type': 'table', 'indent': depth, 'html': html})
            continue

def _indent_from_class(cls):
    for i in range(6, -1, -1):
        if f'indent{i}' in cls:
            return i
    return 0

def _visit_structural(el, blocks, depth, el_type):
    indent = depth
    num_el = el.find(tag('num'))
    heading_el = el.find(tag('heading'))
    num_html = f'<span class="num">{escape_html(num_el.text)}</span>' if num_el is not None and num_el.text else ''
    heading_html = f'<span class="enum-heading">{inline_to_html(heading_el)}</span>' if heading_el is not None else ''

    chapeau_el = el.find(tag('chapeau'))
    content_el = el.find(tag('content'))

    if chapeau_el is not None:
        body_html = _container_to_html(chapeau_el)
        intro_html = f'{num_html} {heading_html}{body_html}'.strip()
        if intro_html:
            blocks.append({'type': el_type, 'indent': indent, 'html': intro_html})
        for child in el:
            if local_name(child) in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, local_name(child))
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
        for child in el:
            if local_name(child) in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, local_name(child))
    else:
        header_html = f'{num_html} {heading_html}'.strip()
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
            intro_html = f'{num_html} {heading_html}{"".join(inline_parts)}'.strip()
            blocks.append({'type': el_type, 'indent': indent, 'html': intro_html})
        elif header_html:
            blocks.append({'type': el_type, 'indent': indent, 'html': header_html})
        for child in el:
            if local_name(child) in STRUCTURAL_ELEMENTS:
                _visit_structural(child, blocks, depth + 1, local_name(child))

def _container_to_html(el):
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
    rows = []
    for row in el.iter(tag('tr')):
        cells = []
        for cell in row:
            ln = local_name(cell)
            if ln in ('td', 'th'):
                inner = inline_to_html(cell)
                attrs = ''
                if cell.get('colspan'):
                    attrs += f' colspan="{cell.get("colspan")}"'
                if cell.get('rowspan'):
                    attrs += f' rowspan="{cell.get("rowspan")}"'
                cells.append(f'<{ln}{attrs}>{inner}</{ln}>')
        if cells:
            rows.append(f'<tr>{"".join(cells)}</tr>')
    return f'<table class="usc-table">{"".join(rows)}</table>' if rows else ''

def get_source_credit(section_el):
    sc_el = section_el.find(tag('sourceCredit'))
    return get_full_text(sc_el).strip() if sc_el is not None else ''

def _note_to_html(note_el):
    parts = []
    for child in note_el:
        ln = local_name(child)
        if ln == 'heading':
            continue
        if ln == 'p':
            inner = inline_to_html(child)
            if inner.strip():
                cls = child.get('class', '')
                parts.append(f'<p class="{cls}">{inner}</p>' if cls else f'<p>{inner}</p>')
        elif ln == 'note':
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
    notes_el = section_el.find(tag('notes'))
    if notes_el is None:
        return []
    notes = []
    for note_el in notes_el.findall(tag('note')):
        topic = note_el.get('topic', 'miscellaneous')
        heading_el = note_el.find(tag('heading'))
        heading = get_full_text(heading_el).strip() if heading_el is not None else ''
        html = _note_to_html(note_el)
        notes.append({'topic': topic, 'heading': heading, 'html': html})
    return notes

def parse_section(section_el):
    identifier = section_el.get('identifier', '')
    num_el = section_el.find(tag('num'))
    heading_el = section_el.find(tag('heading'))
    num_val = num_el.get('value', '') if num_el is not None else ''
    num_text = (num_el.text or '') if num_el is not None else ''
    heading_text = get_full_text(heading_el).strip() if heading_el is not None else ''
    return {
        'number': num_val,
        'numText': num_text,
        'heading': heading_text,
        'identifier': identifier,
        'content': parse_section_to_blocks(section_el),
        'sourceCredit': get_source_credit(section_el),
        'notes': get_notes(section_el),
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

    return {
        'number': num_val,
        'heading': heading_text.rstrip('—').strip(),
        'identifier': identifier,
        'sections': sections,
    }

def parse_title(xml_path):
    print(f"Parsing {xml_path}...")
    tree = ET.parse(xml_path)
    root = tree.getroot()

    meta = root.find(tag('meta'))
    release_point = ''
    updated = ''
    if meta is not None:
        doc_pub = meta.find(tag('docPublicationName'))
        created = meta.find('{http://purl.org/dc/terms/}created')
        if doc_pub is not None:
            release_point = doc_pub.text or ''
        if created is not None:
            updated = (created.text or '').split('T')[0]

    main_el = root.find(tag('main'))
    title_el = main_el.find(tag('title')) if main_el is not None else None

    title_num_el = title_el.find(tag('num')) if title_el is not None else None
    title_num = title_num_el.get('value', '').lstrip('t') if title_num_el is not None else ''
    if not title_num:
        # Infer from filename
        m = re.search(r'usc(\d+)', str(xml_path))
        title_num = str(int(m.group(1))) if m else '?'

    title_heading_el = title_el.find(tag('heading')) if title_el is not None else None
    title_name = get_full_text(title_heading_el).strip() if title_heading_el is not None else ''

    chapters = []
    if title_el is not None:
        for child in title_el:
            if local_name(child) == 'chapter':
                ch = parse_chapter(child)
                print(f"  Ch {ch['number']}: {ch['heading']} ({len(ch['sections'])} §§)")
                chapters.append(ch)

    return {
        'titleNum': title_num,
        'titleName': title_name,
        'releasePoint': release_point,
        'updated': updated,
        'chapters': chapters,
    }

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 parse_xml.py <uscNN.xml> <output-dir> [--toc-only]")
        sys.exit(1)

    xml_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    toc_only = '--toc-only' in sys.argv
    output_dir.mkdir(parents=True, exist_ok=True)

    data = parse_title(xml_path)
    title_num = data['titleNum']

    # TOC fragment for this title
    toc_fragment = {
        'number': title_num,
        'name': data['titleName'],
        'identifier': f'/us/usc/t{title_num}',
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
                ],
            }
            for ch in data['chapters']
        ],
    }

    toc_path = output_dir / f'toc-{title_num}.json'
    with open(toc_path, 'w', encoding='utf-8') as f:
        json.dump(toc_fragment, f, ensure_ascii=False, indent=2)
    print(f"Wrote TOC fragment -> {toc_path}")

    if not toc_only:
        # Full section data for this title
        all_sections = {
            s['number']: s
            for ch in data['chapters']
            for s in ch['sections']
        }
        sections_path = output_dir / f't{title_num}.json'
        with open(sections_path, 'w', encoding='utf-8') as f:
            json.dump(all_sections, f, ensure_ascii=False, separators=(',', ':'))
        total_blocks = sum(len(s['content']) for s in all_sections.values())
        print(f"Wrote {len(all_sections)} sections ({total_blocks} blocks) -> {sections_path}")

    return data['releasePoint'], data['updated']

if __name__ == '__main__':
    main()
