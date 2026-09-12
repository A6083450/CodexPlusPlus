import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('imagegen_sync', Path(__file__).resolve().parents[1] / 'sync.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SynchronizationTests(unittest.TestCase):
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
