import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('imagegen_sync', Path(__file__).resolve().parents[1] / 'sync.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SynchronizationTests(unittest.TestCase):
    def test_owned_facade_rejects_code_added_after_the_integration_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_text('adapter.rs\timagegen_hook\n')
            (source / 'integration/facades.tsv').write_text('adapter.rs\timagegen_hook\n')
            (host / 'adapter.rs').write_text('imagegen_hook\n')
            sync.run(source, host, False)
            (host / 'adapter.rs').write_text('imagegen_hook\nfn imagegen_was_reimplemented() {}\n')
            with self.assertRaisesRegex(ValueError, 'Host facade changed'):
                sync.run(source, host, True)

    def test_hook_counts_detect_a_lost_call_even_when_other_calls_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_text('adapter.rs\timagegen_hook\t2\n')
            (host / 'adapter.rs').write_text('imagegen_hook\nimagegen_hook\n')
            sync.run(source, host, False)
            (host / 'adapter.rs').write_text('imagegen_hook\n')
            with self.assertRaisesRegex(ValueError, 'Host hook count changed'):
                sync.run(source, host, True)

    def test_sync_preserves_an_untracked_host_file_colliding_with_a_new_source_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_text('adapter.rs\timagegen_hook\n')
            (host / 'adapter.rs').write_text('imagegen_hook\n')
            sync.run(source, host, False)
            (source / 'new.js').write_text('source change')
            local = host / 'extensions/imagegen/new.js'
            local.write_text('host change')
            with self.assertRaisesRegex(ValueError, 'Preserving untracked host file'):
                sync.run(source, host, False)
            self.assertEqual(local.read_text(), 'host change')

    def test_unknown_snapshot_files_are_rejected_before_any_file_is_written(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_text('adapter.rs\timagegen_hook\n')
            (source / 'feature.js').write_text('original')
            (host / 'adapter.rs').write_text('imagegen_hook\n')
            sync.run(source, host, False)
            (host / 'extensions/imagegen/foreign.js').write_text('upstream interference')
            (source / 'feature.js').write_text('new version')
            for check in [True, False]:
                with self.assertRaisesRegex(ValueError, 'Unexpected snapshot file'):
                    sync.run(source, host, check)
            self.assertEqual((host / 'extensions/imagegen/feature.js').read_text(), 'original')

    def test_sync_reads_utf8_hooks_with_a_windows_default_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_bytes('adapter.rs\t生图钩子\n'.encode('utf-8'))
            (source / 'feature.js').write_bytes('保留扩展'.encode('utf-8'))
            (host / 'adapter.rs').write_bytes('// 保留生图钩子 🐱'.encode('utf-8'))
            read_text = Path.read_text

            def windows_read_text(path, encoding=None, errors=None):
                return read_text(path, encoding=encoding or 'cp1252', errors=errors)

            with patch.object(Path, 'read_text', windows_read_text):
                sync.run(source, host, False)
                sync.run(source, host, True)
            self.assertEqual((host / 'extensions/imagegen/feature.js').read_bytes(),
                             (source / 'feature.js').read_bytes())

    def test_sync_verifies_content_preserves_edits_and_rejects_lost_hook(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, host = root / 'source', root / 'host'
            (source / 'integration').mkdir(parents=True)
            host.mkdir()
            (source / 'integration/hooks.tsv').write_text('adapter.rs\timagegen_hook\n')
            (source / 'feature.js').write_text('version one')
            (host / 'adapter.rs').write_text('imagegen_hook')
            sync.run(source, host, False)
            sync.run(source, host, True)
            (source / 'feature.js').write_text('version two')
            sync.run(source, host, False)
            snapshot = host / 'extensions/imagegen/feature.js'
            self.assertEqual(snapshot.read_text(), 'version two')
            snapshot.write_text('local edit')
            with self.assertRaises(ValueError):
                sync.run(source, host, False)
            self.assertEqual(snapshot.read_text(), 'local edit')
            with self.assertRaises(ValueError):
                sync.run(source, host, True)
            (host / 'adapter.rs').write_text('upstream removed hook')
            with self.assertRaisesRegex(ValueError, 'Missing host integration'):
                sync.run(source, host, True)


if __name__ == '__main__':
    unittest.main()
