import importlib.util
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import sys
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("managed_update", pathlib.Path(__file__).with_name("managed-update.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateComputerUseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        runtime = patch.object(updater, "HERE", self.runtime)
        runtime.start()
        self.addCleanup(runtime.stop)
        self.source = self.app(self.root / "Claude.app", "old")
        self.copy = self.app(self.runtime / "Claude Enhanced.app", "old")
        self.work = self.runtime / "updates" / "release"
        self.work.mkdir(parents=True)
        self.plan = self.work / "plan.json"
        archive = self.work / "update.zip"
        with zipfile.ZipFile(archive, "w") as file:
            file.writestr("Claude.app/Contents/Info.plist", plistlib.dumps({
                "CFBundleVersion": "new", "CFBundleShortVersionString": "2.0.0",
            }))
        self.value = {
            "source": str(self.source), "copy": str(self.copy), "node": sys.executable,
            "locale": "zh-Hans", "voiceInput": True, "localization": False, "parentPid": 1234,
            "release": {"version": "2.0.0", "size": archive.stat().st_size,
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()},
        }
        # 用实际子进程记录传参和制作标记；系统签名、ditto 与进程等待留在边界替身里。
        (self.runtime / "build-copy.py").write_text('''import json, os, pathlib, shutil, sys
root = pathlib.Path(__file__).parent
source = pathlib.Path(os.environ["CODEX_PLUS_CLAUDE_SOURCE"])
copy = pathlib.Path(os.environ["CODEX_PLUS_CLAUDE_COPY"])
enabled = os.environ.get("CODEX_PLUS_CLAUDE_COMPUTER_USE")
marker = copy / "Contents/Resources/.cu-patched"
with (root / "build-env.jsonl").open("a") as file:
    file.write(json.dumps({"check": "--check" in sys.argv, "computerUse": enabled}) + "\\n")
if "--check" in sys.argv:
    assert marker.is_file() == (enabled == "1"), "Computer Use 校验状态不匹配"
else:
    shutil.copytree(source, copy)
    if enabled == "1":
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("{}")
''')
        (self.runtime / "inject-cn.js").write_text('''import json, os, pathlib
pathlib.Path(__file__).with_name("relaunch.json").write_text(json.dumps({
    "computerUse": os.environ.get("CODEX_PLUS_CLAUDE_COMPUTER_USE"),
    "voiceInput": os.environ.get("CODEX_PLUS_CLAUDE_VOICE_INPUT"),
    "localization": os.environ.get("CODEX_PLUS_CLAUDE_LOCALIZATION"),
}))
''')
        def native_run(args, timeout=300):
            if args[0] == "/usr/bin/ditto":
                if args[1] == "-x":
                    with zipfile.ZipFile(args[3]) as file:
                        file.extractall(args[4])
                else:
                    shutil.copytree(args[1], args[2])
            else:
                self.assertEqual(args[0], "/usr/bin/codesign")
            return SimpleNamespace(returncode=0)
        for target, replacement in [("run", native_run), ("wait_for_exit", lambda pid: None),
                                    ("wait_for_helpers", lambda: None)]:
            boundary = patch.object(updater, target, replacement)
            boundary.start()
            self.addCleanup(boundary.stop)

    def app(self, path, build):
        (path / "Contents").mkdir(parents=True)
        (path / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": build}))
        return path

    def mark_computer_use(self, copy):
        marker = copy / "Contents/Resources/.cu-patched"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("{}")

    def assert_installed(self, enabled):
        updater.install(self.plan, self.value)
        self.assertEqual((self.copy / "Contents/Resources/.cu-patched").is_file(), enabled)
        self.assertEqual(json.loads((self.runtime / "prepared.json").read_text()),
                         {"sourceBuild": "new", "computerUse": enabled})
        self.assertEqual(json.loads((self.runtime / "relaunch.json").read_text()),
                         {"computerUse": "1" if enabled else "0", "voiceInput": "1", "localization": "0"})

    def explicit_update(self, enabled):
        self.value["computerUse"] = enabled
        with patch.dict(os.environ, {"CODEX_PLUS_CLAUDE_COMPUTER_USE": "0" if enabled else "1"}):
            updater.prepare(self.plan, self.value)
            self.assertIs(json.loads(self.plan.read_text())["computerUse"], enabled)
            self.assertEqual((self.work / "Claude CN.app/Contents/Resources/.cu-patched").is_file(), enabled)
            self.assert_installed(enabled)
        for event in (self.runtime / "build-env.jsonl").read_text().splitlines():
            self.assertEqual(json.loads(event)["computerUse"], "1" if enabled else "0")

    def test_enabled_update_overrides_inherited_disabled_env(self):
        self.explicit_update(True)

    def test_disabled_update_overrides_inherited_enabled_env(self):
        self.mark_computer_use(self.copy)
        self.explicit_update(False)

    def test_legacy_plan_preserves_current_copy_marker(self):
        self.mark_computer_use(self.copy)
        (self.runtime / "prepared.json").write_text('{"computerUse": false}')
        with patch.dict(os.environ, {"CODEX_PLUS_CLAUDE_COMPUTER_USE": "0"}):
            updater.prepare(self.plan, self.value)
            self.assert_installed(True)

    def test_legacy_plan_uses_receipt_when_marker_is_missing(self):
        (self.runtime / "prepared.json").write_text('{"computerUse": true}')
        updater.prepare(self.plan, self.value)
        self.assert_installed(True)

    def test_legacy_plan_without_cu_stays_disabled(self):
        with patch.dict(os.environ, {"CODEX_PLUS_CLAUDE_COMPUTER_USE": "1"}):
            updater.prepare(self.plan, self.value)
            self.assert_installed(False)

    def test_legacy_prepared_plan_rebuilds_unpatched_staging_before_replacement(self):
        self.value["computerUse"] = False
        with patch.dict(os.environ, {"CODEX_PLUS_CLAUDE_COMPUTER_USE": "0"}):
            updater.prepare(self.plan, self.value)
            self.value.pop("computerUse")
            self.mark_computer_use(self.copy)
            self.assert_installed(True)
        self.assertTrue((self.work / "Claude CN.app").is_dir(), "保留原先准备的副本")
        self.assertFalse((self.work / "Claude CN.app/Contents/Resources/.cu-patched").exists())

    def test_plan_rejects_non_boolean_computer_use(self):
        self.value["computerUse"] = "false"
        with self.assertRaisesRegex(RuntimeError, "computerUse"):
            updater.prepare(self.plan, self.value)


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
