"""验证官方完整包并重建增强副本；退出后事务替换两份应用，旧版保留。"""
import fcntl
import hashlib
import json
import os
import pathlib
import plistlib
import posixpath
import stat
import subprocess
import sys
import time
import uuid
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
OFFICIAL_SIGNATURE = ('identifier "com.anthropic.claudefordesktop" and anchor apple generic '
                      'and certificate leaf[subject.OU] = "Q6L2SF6YDW"')


def run(args, timeout=300):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-2000:] or "Claude 更新命令失败")
    return result


def info(app):
    with (app / "Contents/Info.plist").open("rb") as file:
        return plistlib.load(file)


def validate_official(app, expected):
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R=" + OFFICIAL_SIGNATURE, app])
    if info(app).get("CFBundleShortVersionString") != expected:
        raise RuntimeError("Claude 官方更新包版本不匹配")


def validate_archive(archive):
    with zipfile.ZipFile(archive) as file:
        for entry in file.infolist():
            name = entry.filename
            if name.startswith("/") or ".." in name.split("/") or "\\" in name:
                raise RuntimeError("Claude 更新归档包含不安全路径")
            if stat.S_ISLNK(entry.external_attr >> 16):
                target = file.read(entry).decode("utf-8")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                    raise RuntimeError("Claude 更新归档包含越界符号链接")


def computer_use_for_update(value):
    if "computerUse" in value:
        enabled = value["computerUse"]
    elif pathlib.Path(value["copy"]).joinpath("Contents/Resources/.cu-patched").is_file():
        enabled = True
    else:
        receipt = HERE / "prepared.json"
        enabled = json.loads(receipt.read_text()).get("computerUse", False) if receipt.is_file() else False
    if not isinstance(enabled, bool):
        raise RuntimeError("Claude 更新计划的 computerUse 必须是 boolean")
    return enabled


def build_copy(source, copy, computer_use):
    env = {**os.environ, "CODEX_PLUS_CLAUDE_SOURCE": str(source), "CODEX_PLUS_CLAUDE_COPY": str(copy),
           "CODEX_PLUS_CLAUDE_COMPUTER_USE": "1" if computer_use else "0"}
    result = subprocess.run([sys.executable, str(HERE / "build-copy.py")], env=env,
                            capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:] or "新版本增强副本构建失败，旧版已保留")


def check_copy(source, copy, computer_use):
    env = {**os.environ, "CODEX_PLUS_CLAUDE_SOURCE": str(source), "CODEX_PLUS_CLAUDE_COPY": str(copy),
           "CODEX_PLUS_CLAUDE_COMPUTER_USE": "1" if computer_use else "0"}
    result = subprocess.run([sys.executable, str(HERE / "build-copy.py"), "--check"],
                            env=env, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:] or "Claude 增强副本校验失败")


def prepare(plan, value):
    value["computerUse"] = computer_use_for_update(value)
    root = plan.parent
    archive = root / "update.zip"
    release = value["release"]
    digest = hashlib.sha256()
    with archive.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != release["sha256"].lower() or archive.stat().st_size != release["size"]:
        raise RuntimeError("Claude 更新包完整性校验失败")
    validate_archive(archive)
    extracted = root / "official"
    run(["/usr/bin/ditto", "-x", "-k", archive, extracted])
    source = extracted / "Claude.app"
    validate_official(source, release["version"])
    current_source, current_copy = pathlib.Path(value["source"]), pathlib.Path(value["copy"])
    if current_source.resolve() == current_copy.resolve():
        raise RuntimeError("官方应用与增强副本不能是同一路径")
    value["sourceBuild"] = info(current_source)["CFBundleVersion"]
    value["copyBuild"] = info(current_copy)["CFBundleVersion"]
    if not os.access(current_source.parent, os.W_OK):
        raise RuntimeError("没有官方 Claude 安装目录的写权限，请先通过官方版更新")
    staged = root / "Claude CN.app"
    build_copy(source, staged, value["computerUse"])
    # 官方暂存目录位于目标旁边，保证最终替换只需原子 rename，即使 state 在另一个卷上。
    official_staged = current_source.with_name(".Claude-update-" + root.name + ".app")
    if official_staged.exists():
        raise RuntimeError("Claude 官方暂存目录已存在")
    run(["/usr/bin/ditto", source, official_staged])
    validate_official(official_staged, release["version"])
    value["officialStaged"] = str(official_staged)
    value["prepared"] = True
    plan.write_text(json.dumps(value))
    (root / "error.txt").unlink(missing_ok=True)


def write_journal(journal, value):
    temporary = journal.with_suffix(".tmp")
    with temporary.open("w") as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(journal)


def recover_transaction(journal):
    value = json.loads(journal.read_text())
    if value["state"] != "pending":
        return
    for staged, target, backup in reversed(value["pairs"]):
        staged, target, backup = map(pathlib.Path, (staged, target, backup))
        if backup.exists():
            if target.exists():
                if staged.exists():
                    raise RuntimeError("Claude 恢复路径被其他程序修改，备份已保留")
                target.rename(staged)
            backup.rename(target)
    write_journal(journal, {**value, "state": "rolled-back"})


def replace_apps(pairs, journal):
    for staged, target, backup in pairs:
        if not staged.is_dir() or not target.is_dir() or backup.exists():
            raise RuntimeError("Claude 更新路径状态已变化，保留现有应用")
    record = {"state": "pending", "pairs": [[str(path) for path in pair] for pair in pairs]}
    write_journal(journal, record)
    try:
        for staged, target, backup in pairs:
            target.rename(backup)
            staged.rename(target)
        write_journal(journal, {**record, "state": "committed"})
    except Exception:
        recover_transaction(journal)
        raise


def recover_pending_updates():
    for journal in (HERE / "updates").glob("*/transaction.json"):
        if json.loads(journal.read_text())["state"] == "pending":
            running = subprocess.run(["/usr/bin/pgrep", "-f", "/Contents/MacOS/Claude( |$)"], capture_output=True)
            if running.returncode != 1:
                raise RuntimeError("Claude 更新曾中断，请完全退出 Claude 后再启动副本以恢复")
            recover_transaction(journal)


def wait_for_exit(pid):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    raise RuntimeError("Claude 尚未退出，未替换任何应用")


def wait_for_helpers():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        running = subprocess.run(["/usr/bin/pgrep", "-f", "/Contents/MacOS/Claude( |$)"], capture_output=True)
        if running.returncode == 1:
            return
        if running.returncode != 0:
            break
        time.sleep(0.2)
    raise RuntimeError("还有 Claude 进程未退出，更新已停止，原应用保留")


def install(plan, value):
    if not value.get("prepared") or not pathlib.Path(value["officialStaged"]).is_dir():
        raise RuntimeError("Claude 更新尚未通过完整校验")
    value["computerUse"] = computer_use_for_update(value)
    print("ready", flush=True)
    wait_for_exit(value["parentPid"])
    wait_for_helpers()
    root = plan.parent
    source, copy = pathlib.Path(value["source"]), pathlib.Path(value["copy"])
    if info(source)["CFBundleVersion"] != value["sourceBuild"] or info(copy)["CFBundleVersion"] != value["copyBuild"]:
        raise RuntimeError("准备更新后 Claude 版本发生变化，请重新检查更新")
    official_staged = pathlib.Path(value["officialStaged"])
    validate_official(official_staged, value["release"]["version"])
    staged = root / "Claude CN.app"
    if staged.joinpath("Contents/Resources/.cu-patched").is_file() != value["computerUse"]:
        # 旧计划可能已准备了不带 CU 的副本；另建暂存，保留原产物供恢复。
        staged = root / ("Claude-rebuilt-" + uuid.uuid4().hex + ".app")
        build_copy(official_staged, staged, value["computerUse"])
    check_copy(official_staged, staged, value["computerUse"])
    replace_apps([(official_staged, source, source.with_name(".Claude-backup-" + root.name + ".app")),
                  (staged, copy, root / "previous-copy.app")], root / "transaction.json")
    receipt = HERE / "prepared.json"
    receipt_temp = root / "prepared.json"
    receipt_temp.write_text(json.dumps({"sourceBuild": info(source)["CFBundleVersion"],
                                       "computerUse": value["computerUse"]}))
    receipt_temp.replace(receipt)
    value["installed"] = True
    plan.write_text(json.dumps(value))
    env = {**os.environ, "CODEX_PLUS_CLAUDE_SOURCE": str(source), "CODEX_PLUS_CLAUDE_COPY": str(copy),
           "CODEX_PLUS_CLAUDE_PYTHON": sys.executable,
           "CODEX_PLUS_CLAUDE_COMPUTER_USE": "1" if value["computerUse"] else "0",
           "CODEX_PLUS_CLAUDE_VOICE_INPUT": "1" if value["voiceInput"] else "0",
           "CODEX_PLUS_CLAUDE_LOCALIZATION": "1" if value["localization"] else "0"}
    result = subprocess.run([value["node"], str(HERE / "inject-cn.js"), "--locale", value["locale"]],
                            env=env, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError("两份应用已更新，但启动注入失败：" + result.stderr[-1000:])


if __name__ == "__main__":
    plan = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    try:
        with (HERE / "update.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            recover_pending_updates()
            value = json.loads(plan.read_text()) if plan else None
            if sys.argv[1] == "--recover":
                pass
            elif sys.argv[1] == "--prepare":
                prepare(plan, value)
            elif sys.argv[1] == "--install":
                install(plan, value)
            else:
                raise RuntimeError("未知更新操作")
    except Exception as error:
        print(str(error), file=sys.stderr)
        if plan:
            (plan.parent / "error.txt").write_text(str(error))
        if sys.argv[1] == "--install":
            subprocess.run(["/usr/bin/osascript", "-e", 'on run argv\n display alert "Claude 更新失败" message (item 1 of argv)\nend run',
                            str(error)], timeout=60)
        sys.exit(1)
