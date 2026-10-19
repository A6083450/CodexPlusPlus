import importlib.util
import pathlib
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("managed_update", pathlib.Path(__file__).with_name("managed-update.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTransactionTests(unittest.TestCase):
    def test_helpers_still_exiting_are_waited_for(self):
        with patch.object(updater.subprocess, "run", side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=1)]), \
                patch.object(updater.time, "sleep"):
            updater.wait_for_helpers()

    def seed(self, root, name, contents):
        path = root / name
        path.mkdir()
        (path / "version").write_text(contents)
        return path

    def test_both_apps_are_replaced_and_backups_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            pairs = [(self.seed(root, "new-official", "new"), self.seed(root, "official", "old"), root / "old-official"),
                     (self.seed(root, "new-copy", "new-cn"), self.seed(root, "copy", "old-cn"), root / "old-copy")]
            updater.replace_apps(pairs, root / "transaction.json")
            self.assertEqual((root / "official/version").read_text(), "new")
            self.assertEqual((root / "copy/version").read_text(), "new-cn")
            self.assertEqual((root / "old-official/version").read_text(), "old")
            self.assertEqual((root / "old-copy/version").read_text(), "old-cn")

    def test_second_app_failure_restores_both_apps(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            pairs = [(self.seed(root, "new-official", "new"), self.seed(root, "official", "old"), root / "old-official"),
                     (self.seed(root, "new-copy", "new-cn"), self.seed(root, "copy", "old-cn"), root / "old-copy")]
            rename = pathlib.Path.rename
            def fail_copy(path, target):
                if path == root / "new-copy":
                    raise OSError("copy replacement failed")
                return rename(path, target)
            with patch.object(pathlib.Path, "rename", fail_copy):
                with self.assertRaisesRegex(OSError, "copy replacement failed"):
                    updater.replace_apps(pairs, root / "transaction.json")
            self.assertEqual((root / "official/version").read_text(), "old")
            self.assertEqual((root / "copy/version").read_text(), "old-cn")
            self.assertEqual((root / "new-official/version").read_text(), "new")

    def test_existing_backup_aborts_before_changing_either_app(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            pairs = [(self.seed(root, "new", "new"), self.seed(root, "app", "old"), self.seed(root, "backup", "saved"))]
            with self.assertRaises(Exception):
                updater.replace_apps(pairs, root / "transaction.json")
            self.assertEqual((root / "app/version").read_text(), "old")
            self.assertEqual((root / "backup/version").read_text(), "saved")

    def test_archive_rejects_path_traversal_and_escaping_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = pathlib.Path(temp) / "update.zip"
            for name, target in [("../outside", None), ("/outside", None), ("Claude.app/link", "../../outside")]:
                with zipfile.ZipFile(archive, "w") as file:
                    entry = zipfile.ZipInfo(name)
                    if target:
                        entry.external_attr = 0o120777 << 16
                    file.writestr(entry, target or "bad")
                with self.assertRaisesRegex(RuntimeError, "不安全|越界"):
                    updater.validate_archive(archive)

    def test_interrupted_transaction_can_be_recovered_from_disk(self):
        for interrupt_after in [1, 2, 3, 4]:
            with self.subTest(interrupt_after=interrupt_after), tempfile.TemporaryDirectory() as temp:
                root = pathlib.Path(temp)
                pairs = [(self.seed(root, "new-official", "new"), self.seed(root, "official", "old"), root / "old-official"),
                         (self.seed(root, "new-copy", "new-cn"), self.seed(root, "copy", "old-cn"), root / "old-copy")]
                journal = root / "transaction.json"
                rename = pathlib.Path.rename
                moves = 0
                def terminate(path, target):
                    nonlocal moves
                    result = rename(path, target)
                    if path.name != "transaction.tmp":
                        moves += 1
                        if moves == interrupt_after:
                            raise KeyboardInterrupt("simulated process death")
                    return result
                with patch.object(pathlib.Path, "rename", terminate):
                    with self.assertRaises(KeyboardInterrupt):
                        updater.replace_apps(pairs, journal)
                updater.recover_transaction(journal)
                self.assertEqual((root / "official/version").read_text(), "old")
                self.assertEqual((root / "copy/version").read_text(), "old-cn")


if __name__ == "__main__":
    unittest.main()
