import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

checker = Path(__file__).resolve().parents[1] / 'check.py'
spec = importlib.util.spec_from_file_location('imagegen_check', checker)
package_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_check)


class PackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Path(temporary.name) / 'repo'
        self.package = self.host / 'extensions/imagegen'
        (self.package / 'integration').mkdir(parents=True)
        (self.package / 'integration/hooks.tsv').write_text('adapter.rs\thook\t2\n', encoding='utf-8')
        (self.package / 'integration/facades.tsv').write_text('facade.rs\tdelegate\n', encoding='utf-8')
        (self.host / 'adapter.rs').write_text('hook\nhook\n', encoding='utf-8')
        (self.host / 'facade.rs').write_text('delegate\n', encoding='utf-8')
        self.feature = self.package / 'feature.js'
        self.feature.write_text('local implementation', encoding='utf-8')
        self.manifest = self.package / 'MANIFEST.json'

    def test_local_edits_require_explicit_manifest_refresh_without_replacing_code(self):
        package_check.run(self.host, update=True)
        package_check.run(self.host)
        self.feature.write_text('reviewed local edit', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Package content changed'):
            package_check.run(self.host)
        package_check.run(self.host, update=True)
        package_check.run(self.host)
        self.assertEqual(self.feature.read_text(), 'reviewed local edit')

    def test_sibling_repository_is_never_read_or_written(self):
        sibling = self.host.parent / 'CodexPlusPlus-imagegen'
        sibling.mkdir()
        foreign = sibling / 'feature.js'
        foreign.write_text('obsolete external implementation')
        package_check.run(self.host, update=True)
        package_check.run(self.host)
        self.assertEqual(self.feature.read_text(), 'local implementation')
        self.assertEqual(foreign.read_text(), 'obsolete external implementation')
        self.assertFalse((sibling / 'MANIFEST.json').exists())

    def test_added_and_removed_package_files_require_manifest_review(self):
        package_check.run(self.host, update=True)
        extra = self.package / 'new.js'
        extra.write_text('reviewed feature')
        with self.assertRaisesRegex(ValueError, 'Package content changed: new.js'):
            package_check.run(self.host)
        package_check.run(self.host, update=True)
        extra.rename(extra.with_name('renamed.js'))
        with self.assertRaisesRegex(ValueError, 'Package content changed'):
            package_check.run(self.host)
        self.assertEqual(extra.with_name('renamed.js').read_text(), 'reviewed feature')

    def test_changed_facades_block_both_checking_and_manifest_refresh(self):
        package_check.run(self.host, update=True)
        before = self.manifest.read_bytes()
        (self.host / 'facade.rs').write_text('delegate\nunwanted implementation\n')
        for update in [False, True]:
            with self.assertRaisesRegex(ValueError, 'Host facade changed'):
                package_check.run(self.host, update=update)
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_missing_or_partial_hooks_cannot_be_accepted_by_refreshing_the_manifest(self):
        package_check.run(self.host, update=True)
        before = self.manifest.read_bytes()
        (self.host / 'adapter.rs').write_text('hook\n')
        with self.assertRaisesRegex(ValueError, 'Host hook count changed'):
            package_check.run(self.host, update=True)
        (self.host / 'adapter.rs').write_text('removed')
        with self.assertRaisesRegex(ValueError, 'Missing host integration'):
            package_check.run(self.host)
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_utf8_contracts_work_with_a_windows_default_encoding(self):
        (self.package / 'integration/hooks.tsv').write_text('adapter.rs\t生图钩子\n', encoding='utf-8')
        (self.host / 'adapter.rs').write_text('生图钩子', encoding='utf-8')
        original = Path.read_text

        def windows_read_text(path, encoding=None, errors=None):
            return original(path, encoding=encoding or 'cp1252', errors=errors)

        with patch.object(Path, 'read_text', windows_read_text):
            package_check.run(self.host, update=True)
            package_check.run(self.host)

    def test_cli_only_checks_or_refreshes_the_local_manifest(self):
        for mode in ['--update-manifest', '--check']:
            result = subprocess.run([sys.executable, str(checker), mode, '--target', str(self.host)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        before = self.manifest.read_bytes()
        result = subprocess.run([sys.executable, str(checker), '--sync', '--target', str(self.host)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(self.feature.read_text(), 'local implementation')


if __name__ == '__main__':
    unittest.main()
