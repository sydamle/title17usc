#!/usr/bin/env python3
"""
Merge per-title toc-N.json fragments (produced by parse_xml.py) into
a single public/data/toc.json for the app.

Usage:
    python3 scripts/build_toc.py <data-dir> <output-toc-path> [release-point] [updated]

Example:
    python3 scripts/build_toc.py /tmp/uscode-data public/data/toc.json

The script reads all toc-*.json files found in <data-dir>, sorts them by
title number, and writes the combined toc.json.
"""

import json
import sys
import re
from pathlib import Path

# Canonical title names (some XML headings are abbreviated)
TITLE_NAMES = {
    '1':  'General Provisions',
    '2':  'The Congress',
    '3':  'The President',
    '4':  'Flag and Seal, Seat of Government, and the States',
    '5':  'Government Organization and Employees',
    '6':  'Domestic Security',
    '7':  'Agriculture',
    '8':  'Aliens and Nationality',
    '9':  'Arbitration',
    '10': 'Armed Forces',
    '11': 'Bankruptcy',
    '12': 'Banks and Banking',
    '13': 'Census',
    '14': 'Coast Guard',
    '15': 'Commerce and Trade',
    '16': 'Conservation',
    '17': 'Copyrights',
    '18': 'Crimes and Criminal Procedure',
    '19': 'Customs Duties',
    '20': 'Education',
    '21': 'Food and Drugs',
    '22': 'Foreign Relations and Intercourse',
    '23': 'Highways',
    '24': 'Hospitals and Asylums',
    '25': 'Indians',
    '26': 'Internal Revenue Code',
    '27': 'Intoxicating Liquors',
    '28': 'Judiciary and Judicial Procedure',
    '29': 'Labor',
    '30': 'Mineral Lands and Mining',
    '31': 'Money and Finance',
    '32': 'National Guard',
    '33': 'Navigation and Navigable Waters',
    '34': 'Crime Control and Law Enforcement',
    '35': 'Patents',
    '36': 'Patriotic and National Observances, Ceremonies, and Organizations',
    '37': 'Pay and Allowances of the Uniformed Services',
    '38': "Veterans' Benefits",
    '39': 'Postal Service',
    '40': 'Public Buildings, Property, and Works',
    '41': 'Public Contracts',
    '42': 'The Public Health and Welfare',
    '43': 'Public Lands',
    '44': 'Public Printing and Documents',
    '45': 'Railroads',
    '46': 'Shipping',
    '47': 'Telecommunications',
    '48': 'Territories and Insular Possessions',
    '49': 'Transportation',
    '50': 'War and National Defense',
    '51': 'National and Commercial Space Programs',
    '52': 'Voting and Elections',
    '54': 'National Park Service and Related Programs',
}

def num_sort_key(n):
    """Sort title numbers numerically."""
    try:
        return int(n)
    except ValueError:
        return 9999

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 build_toc.py <data-dir> <output-toc-path> [release-point] [updated]")
        sys.exit(1)

    data_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    release_point = sys.argv[3] if len(sys.argv) > 3 else ''
    updated = sys.argv[4] if len(sys.argv) > 4 else ''

    fragments = []
    for path in sorted(data_dir.glob('toc-*.json')):
        with open(path, encoding='utf-8') as f:
            frag = json.load(f)
        # Use canonical name if available
        num = frag['number']
        if num in TITLE_NAMES:
            frag['name'] = TITLE_NAMES[num]
        fragments.append(frag)
        if not release_point:
            # Try to infer from section identifiers
            pass

    fragments.sort(key=lambda f: num_sort_key(f['number']))

    toc = {
        'releasePoint': release_point or '119-73not60',
        'updated': updated or '',
        'titles': fragments,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(toc, f, ensure_ascii=False, indent=2)

    total_sections = sum(
        len(ch['sections'])
        for t in fragments
        for ch in t['chapters']
    )
    print(f"Merged {len(fragments)} titles, {total_sections} sections -> {output_path}")

if __name__ == '__main__':
    main()
