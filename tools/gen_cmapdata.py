# -*- coding: utf-8 -*-
"""Write js/cmapdata.js: the Scientific colour maps as 256-entry hex LUTs.

Run from the digital_twin_viewer directory:  python tools/gen_cmapdata.py Re-run to update after a cmcrameri
upgrade; the file it writes is generated and should not be hand-edited.
"""
import numpy as np
from cmcrameri import cm
import cmcrameri

GROUPS = [
    ('sequential', ['batlow', 'batlowK', 'devon', 'oslo', 'lapaz', 'davos', 'nuuk',
                    'bamako', 'lajolla', 'bilbao', 'turku', 'imola', 'hawaii',
                    'grayC', 'navia', 'lipari']),
    ('diverging',  ['vik', 'roma', 'broc', 'cork', 'berlin', 'lisbon', 'tofino', 'bam']),
    ('multi',      ['oleron', 'bukavu', 'fes']),
    ('cyclic',     ['romaO', 'vikO', 'brocO']),
]

N = 256


def hexlut(name):
    rgb = np.round(np.asarray(getattr(cm, name)(np.linspace(0, 1, N)))[:, :3] * 255)
    return ''.join('%02x%02x%02x' % tuple(int(v) for v in row) for row in rgb.astype(int))


lines = [
    '// GENERATED FILE - do not hand-edit.',
    '//',
    '// The Scientific colour maps by Fabio Crameri (https://www.fabiocrameri.ch/colourmaps/),',
    f'// sampled from cmcrameri {cmcrameri.__version__} at {N} points and stored as packed RGB hex.',
    '//',
    '// Why a full lookup table rather than a handful of interpolation stops: the',
    '// multi-sequential maps (oleron, bukavu, fes) carry a deliberate hard break at',
    '// the midpoint, where sea meets land. No number of evenly spaced stops can',
    "// reproduce a discontinuity by linear interpolation - oleron's step is the full",
    '// 255 in one channel - so the table is stored at the resolution it is used at.',
    '//',
    '// These maps are perceptually uniform and readable with the common colour',
    '// vision deficiencies; that property is the reason to prefer them, and it only',
    '// holds if the values are reproduced exactly.',
    '//',
    '// Regenerate with:  python tools/gen_cmapdata.py',
    '',
    'export const CRAMERI_KIND = {',
]
for kind, names in GROUPS:
    lines.append(f"  // {kind}")
    for n in names:
        lines.append(f"  {n}: '{kind}',")
lines.append('};')
lines.append('')
lines.append('/** name -> 256 RGB triples, 6 hex digits each. */')
lines.append('export const CRAMERI = {')
for kind, names in GROUPS:
    for n in names:
        lines.append(f"  {n}: '{hexlut(n)}',")
lines.append('};')
lines.append('')

out = '\n'.join(lines)
with open('js/cmapdata.js', 'w', encoding='utf-8', newline='') as f:
    f.write(out)

total = sum(len(v) for _, ns in GROUPS for v in ns)
print(f'js/cmapdata.js: {sum(len(ns) for _, ns in GROUPS)} maps, {len(out)/1024:.1f} KB')
