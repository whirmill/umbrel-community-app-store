#!/usr/bin/env python3
"""Offline reproducible static font instances; build-only fontTools 4.63.0."""
import hashlib
import json
import pathlib
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

if fontTools.__version__ != '4.63.0':
    raise ValueError('Pinned fontTools 4.63.0 required')
root = pathlib.Path(__file__).resolve().parent.parent / 'content/dls/v1/fonts'
entries = []
for source, output, weight in [('Manrope.ttf', 'Manrope-700.ttf', 700), ('DMSans.ttf', 'DMSans-400.ttf', 400), ('DMSans.ttf', 'DMSans-700.ttf', 700)]:
    font = TTFont(root / source, recalcTimestamp=False)
    axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes}
    axes['wght'] = weight
    instance = instantiateVariableFont(font, axes, inplace=False, updateFontNames=True)
    assert 'fvar' not in instance
    instance.recalcTimestamp = False
    instance.save(root / output)
    entries.append({'file': output, 'derivedFrom': source, 'sourceSha256': hashlib.sha256((root / source).read_bytes()).hexdigest(), 'axes': axes, 'generator': 'fontTools 4.63.0 instantiateVariableFont', 'sha256': hashlib.sha256((root / output).read_bytes()).hexdigest()})
(root / 'static-manifest.json').write_text(json.dumps(entries, indent=2) + '\n')
print(json.dumps([e['sha256'] for e in entries]))
