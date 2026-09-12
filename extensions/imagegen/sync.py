#!/usr/bin/env python3
"""Synchronize the independent imagegen source, or verify its host snapshot and hooks."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_files(source):
    return {p.relative_to(source).as_posix(): p.read_bytes() for p in source.rglob('*')
            if p.is_file() and not {'.git', '__pycache__'}.intersection(p.relative_to(source).parts)
            and p.name != 'MANIFEST.json' and p.suffix != '.pyc'}


def check_hooks(source, host):
    for line in (source / 'integration/hooks.tsv').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        name, marker = line.split('\t', 1)
        path = host / name
        if not path.is_file() or marker not in path.read_text():
            raise ValueError(f'Missing host integration: {name}: {marker}')


def run(source, host, check):
    files = source_files(source)
    target = host / 'extensions/imagegen'
    manifest_path = target / 'MANIFEST.json'
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    check_hooks(source, host)
    if check:
        expected = {name: digest(data) for name, data in files.items()}
        if old != expected:
            raise ValueError('Imagegen snapshot manifest differs from independent source; review then synchronize')
        for name, data in files.items():
            if not (target / name).is_file() or (target / name).read_bytes() != data:
                raise ValueError(f'Imagegen snapshot changed: {name}')
    else:
        for name, checksum in old.items():
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('Invalid snapshot manifest path')
            path = target / name
            if name not in files:
                raise ValueError(f'Source removed {name}; reconcile it explicitly before synchronizing')
            if not path.exists() or digest(path.read_bytes()) != checksum:
                raise ValueError(f'Preserving modified host file: {name}; reconcile it before synchronizing')
        for name, data in files.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists() or path.read_bytes() != data:
                temporary = path.with_name(path.name + '.sync-tmp')
                temporary.write_bytes(data)
                temporary.replace(path)
        manifest = json.dumps({name: digest(data) for name, data in sorted(files.items())}, indent=2) + '\n'
        manifest_path.write_text(manifest)
        if source != target:
            (source / 'MANIFEST.json').write_text(manifest)
    print(f'Imagegen {"verified" if check else "synchronized"}: {len(files)} files; host hooks intact')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True, help='CodexPlusPlus checkout')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--sync', action='store_true')
    args = parser.parse_args()
    try:
        run(Path(__file__).resolve().parent, args.target.resolve(), args.check)
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
