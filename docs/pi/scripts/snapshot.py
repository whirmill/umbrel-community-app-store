#!/usr/bin/env python3
"""Pinned documentation snapshots; refresh is explicit, verification is offline."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DOC = ROOT / 'docs/pi'
VERSION = '1.1.0'
COMMIT = 'abe508e1b89912adde45528136c3221eb69acdd7'
WATCH_COMMIT = '42a3497d03ad17e308a2299fa824727894f2c0ec'
REPO = 'https://github.com/earendil-works/pi'
APP = ROOT / 'whirmill-satssurge-autopilot'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'SatsSurge-pinned-docs'})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def local_versions():
    package = json.loads((APP / 'package.json').read_text())
    lock = json.loads((APP / 'package-lock.json').read_text())
    versions = {}
    for name in ['pi-ai', 'pi-durable', 'chord']:
        full = '@earendil-works/' + name
        installed = lock['packages']['node_modules/' + full]
        if package['dependencies'][full] != VERSION or installed['version'] != VERSION:
            raise ValueError('Version mismatch for ' + full + '; explicitly update documentation first')
        versions[full] = {key: installed.get(key) for key in ['version', 'resolved', 'integrity']}
    return versions


def refresh():
    versions = local_versions()
    tree = json.loads(fetch('https://api.github.com/repos/earendil-works/pi/git/trees/' + COMMIT + '?recursive=1'))
    if tree.get('truncated'):
        raise ValueError('Upstream tree is truncated')
    fixed = {'LICENSE', 'README.md', 'packages/ai/README.md', 'packages/agent/README.md',
             'packages/chord/README.md', 'packages/coding-agent/README.md',
             'packages/durable/README.md', 'packages/durable/CHANGELOG.md',
             'packages/durable/docs/spec.md'}
    paths = sorted(x['path'] for x in tree['tree'] if x['type'] == 'blob' and
                   (x['path'] in fixed or
                    (x['path'].startswith('packages/coding-agent/docs/') and x['path'].endswith('.md')) or
                    (x['path'].startswith('packages/durable/test/examples/') and x['path'].endswith('.ts'))))
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    sources = []

    def acquire(path):
        url = 'https://raw.githubusercontent.com/earendil-works/pi/' + COMMIT + '/' + path
        return path, url, fetch(url)

    # Acquire everything before writing; a failed fetch does not replace the manifest.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        downloaded = list(pool.map(acquire, paths))
    for path, _, data in downloaded:
        if path in ['packages/durable/README.md', 'packages/durable/CHANGELOG.md']:
            installed = APP / 'node_modules/@earendil-works/pi-durable' / Path(path).name
            if installed.read_bytes() != data:
                raise ValueError('Installed package differs from pinned upstream: ' + path)

    for path, url, data in downloaded:
        target = DOC / 'upstream' / ('v' + VERSION) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        sources.append({'path': str(target.relative_to(DOC)), 'url': url, 'commit': COMMIT,
                        'license': 'MIT', 'retrieved_at': stamp, 'bytes': len(data), 'sha256': sha(data)})

    installed_root = APP / 'node_modules/@earendil-works/pi-durable'
    declarations = sorted((installed_root / 'dist').rglob('*.d.ts'))
    if not declarations:
        raise ValueError('Installed Durable declarations missing')
    for source in [installed_root / 'package.json', *declarations]:
        relative = source.relative_to(installed_root)
        target = DOC / 'installed' / ('pi-durable-' + VERSION) / relative
        data = source.read_bytes()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        sources.append({'path': str(target.relative_to(DOC)),
                        'url': versions['@earendil-works/pi-durable']['resolved'],
                        'package': '@earendil-works/pi-durable', 'version': VERSION,
                        'package_path': str(relative), 'license': 'MIT',
                        'retrieved_at': stamp, 'bytes': len(data), 'sha256': sha(data)})
    watch_url = 'https://raw.githubusercontent.com/earendil-works/pi/' + WATCH_COMMIT + '/packages/durable/CHANGELOG.md'
    data = fetch(watch_url)
    target = DOC / 'upgrade-watch/durable-42a3497d-CHANGELOG.md'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    sources.append({'path': str(target.relative_to(DOC)), 'url': watch_url, 'commit': WATCH_COMMIT,
                    'status': 'upgrade-reference-only', 'license': 'MIT', 'retrieved_at': stamp,
                    'bytes': len(data), 'sha256': sha(data)})
    manifest = {'schema': 1, 'version': VERSION, 'upstream_repo': REPO, 'upstream_commit': COMMIT,
                'created_at': stamp, 'packages': versions,
                'sources': sorted(sources, key=lambda x: x['path'])}
    (DOC / 'SOURCES.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify()


def verify():
    versions = local_versions()
    manifest = json.loads((DOC / 'SOURCES.json').read_text())
    if manifest['version'] != VERSION or manifest['upstream_commit'] != COMMIT or manifest['packages'] != versions:
        raise ValueError('Manifest and installed dependency contract differ')
    seen = set()
    for item in manifest['sources']:
        path = (DOC / item['path']).resolve()
        if not path.is_relative_to(DOC.resolve()) or item['path'] in seen:
            raise ValueError('Invalid or duplicate source path')
        seen.add(item['path'])
        data = path.read_bytes()
        if len(data) != item['bytes'] or sha(data) != item['sha256']:
            raise ValueError('Source verification failed: ' + item['path'])
    if 'upstream/v1.1.0/LICENSE' not in seen:
        raise ValueError('License missing')
    print('Verified', len(seen), 'pinned sources; package versions and SHA-256/size match')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--refresh', action='store_true')
    mode.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    refresh() if args.refresh else verify()
