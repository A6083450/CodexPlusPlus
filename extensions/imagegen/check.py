#!/usr/bin/env python3
"""Verify the in-repository imagegen package or refresh its local integrity manifest."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package_files(source):
    return {p.relative_to(source).as_posix(): p.read_bytes() for p in source.rglob('*')
            if p.is_file() and not {'.git', '__pycache__'}.intersection(p.relative_to(source).parts)
            and p.name != 'MANIFEST.json' and p.suffix != '.pyc'}


def check_hooks(source, host):
    for line in (source / 'integration/hooks.tsv').read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        name, marker, *count = line.split('\t')
        path = host / name
        content = path.read_text(encoding='utf-8') if path.is_file() else ''
        if marker not in content:
            raise ValueError(f'Missing host integration: {name}: {marker}')
        if count and content.count(marker) != int(count[0]):
            raise ValueError(f'Host hook count changed: {name}: {marker}')
    facades = source / 'integration/facades.tsv'
    if facades.is_file():
        for line in facades.read_text(encoding='utf-8').splitlines():
            if not line or line.startswith('#'):
                continue
            name, expected = line.split('\t', 1)
            path = host / name
            if not path.is_file() or path.read_text(encoding='utf-8').rstrip() != expected.replace('\\n', '\n'):
                raise ValueError(f'Host facade changed: {name}; keep implementation in extensions/imagegen')


def run(host, update=False):
    package = host / 'extensions/imagegen'
    check_hooks(package, host)
    files = package_files(package)
    expected = {name: digest(data) for name, data in sorted(files.items())}
    manifest_path = package / 'MANIFEST.json'
    if update:
        manifest_path.write_text(json.dumps(expected, indent=2) + '\n', encoding='utf-8')
    else:
        recorded = json.loads(manifest_path.read_text(encoding='utf-8'))
        if recorded != expected:
            changed = sorted(name for name in recorded.keys() | expected.keys()
                             if recorded.get(name) != expected.get(name))
            raise ValueError(f'Package content changed: {changed[0]}; review changes then run check.py --update-manifest --target .')
    print(f'Imagegen {"manifest updated" if update else "verified"}: {len(files)} files; host hooks intact')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True, help='CodexPlusPlus checkout')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--update-manifest', action='store_true')
    args = parser.parse_args()
    try:
        run(args.target.resolve(), update=args.update_manifest)
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
