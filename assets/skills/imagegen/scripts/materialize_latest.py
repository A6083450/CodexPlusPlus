#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path


def normalize_thread_id(value: str) -> str:
    thread_id = value.strip()
    for prefix in ("local:", "thread:"):
        if thread_id.startswith(prefix):
            thread_id = thread_id[len(prefix) :]
    return thread_id


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()


def database_paths(home: Path) -> list[Path]:
    preferred = [home / "state_5.sqlite", home / "state.sqlite"]
    paths = preferred + sorted(home.glob("state_*.sqlite"))
    unique = []
    for path in paths:
        if path.is_file() and path not in unique:
            unique.append(path)
    return unique


def rollout_path_for_thread(home: Path, thread_id: str) -> Path:
    for db_path in database_paths(home):
        try:
            connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(threads)").fetchall()
            }
            if not {"id", "rollout_path"}.issubset(columns):
                connection.close()
                continue
            row = connection.execute(
                "SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)
            ).fetchone()
            connection.close()
        except sqlite3.Error:
            continue
        if row and row[0]:
            rollout_path = Path(row[0]).expanduser()
            if rollout_path.is_file():
                return rollout_path
    raise RuntimeError(f"rollout not found for thread {thread_id}")


def image_records(rollout_path: Path) -> list[dict[str, str]]:
    records = []
    with rollout_path.open("r", encoding="utf-8") as rollout:
        for line in rollout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "response_item":
                continue
            payload = event.get("payload") or {}
            if (
                payload.get("type") != "image_generation_call"
                or payload.get("status") != "completed"
            ):
                continue
            encoded = str(payload.get("result") or "").strip()
            if not encoded:
                continue
            image_id = str(payload.get("id") or "").strip()
            if not image_id:
                image_id = f"ig_{hashlib.sha256(encoded.encode()).hexdigest()[:48]}"
            media_type = "image/png"
            extension = "png"
            if encoded.startswith("/9j/"):
                media_type = "image/jpeg"
                extension = "jpg"
            elif encoded.startswith("UklGR"):
                media_type = "image/webp"
                extension = "webp"
            records.append(
                {
                    "id": image_id,
                    "encoded": encoded,
                    "media_type": media_type,
                    "extension": extension,
                }
            )
    return records


def safe_stem(value: str) -> str:
    stem = "".join(
        character if character.isascii() and (character.isalnum() or character in "-_") else "_"
        for character in value
    )
    return stem or "generated-image"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(data)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def baseline_path(home: Path, thread_id: str) -> Path:
    return home / "generated_images" / thread_id / ".delivery-baseline"


def write_baseline(home: Path, thread_id: str, image_id: str) -> None:
    atomic_write(baseline_path(home, thread_id), image_id.encode("utf-8"))


def read_baseline(home: Path, thread_id: str) -> str:
    path = baseline_path(home, thread_id)
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


def select_after(records: list[dict[str, str]], after_id: str) -> dict[str, str] | None:
    if not after_id:
        return records[-1] if records else None
    baseline_index = None
    for index, record in enumerate(records):
        if record["id"] == after_id:
            baseline_index = index
    if baseline_index is None:
        return None
    candidates = records[baseline_index + 1 :]
    return candidates[-1] if candidates else None


def materialize(home: Path, thread_id: str, record: dict[str, str]) -> dict[str, str]:
    image_bytes = base64.b64decode(record["encoded"], validate=True)
    image_path = (
        home
        / "generated_images"
        / thread_id
        / f"{safe_stem(record['id'])}.{record['extension']}"
    )
    if image_path.is_file():
        if image_path.read_bytes() != image_bytes:
            raise RuntimeError(f"existing image differs: {image_path}")
    else:
        atomic_write(image_path, image_bytes)
    return {
        "status": "ok",
        "thread_id": thread_id,
        "id": record["id"],
        "media_type": record["media_type"],
        "path": str(image_path),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--thread-id", default=os.environ.get("CODEX_THREAD_ID", ""))
    parser.add_argument("--peek", action="store_true")
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("--after-id")
    parser.add_argument("--after-snapshot", action="store_true")
    parser.add_argument("--wait-seconds", type=float, default=0.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    thread_id = normalize_thread_id(args.thread_id)
    if not thread_id:
        raise RuntimeError("CODEX_THREAD_ID is not available")
    home = codex_home()
    rollout_path = rollout_path_for_thread(home, thread_id)
    records = image_records(rollout_path)
    latest_id = records[-1]["id"] if records else ""
    if args.peek:
        print(latest_id)
        return 0
    if args.snapshot:
        write_baseline(home, thread_id, latest_id)
        print(latest_id)
        return 0
    after_id = read_baseline(home, thread_id) if args.after_snapshot else args.after_id
    deadline = time.monotonic() + max(0.0, args.wait_seconds)
    while True:
        records = image_records(rollout_path)
        selected = select_after(records, after_id or "")
        if selected is not None and selected["id"] != (after_id or ""):
            print(json.dumps(materialize(home, thread_id, selected), ensure_ascii=True))
            return 0
        if time.monotonic() >= deadline:
            raise RuntimeError("no completed image generation found after baseline")
        time.sleep(0.2)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "message": str(error)}), file=sys.stderr)
        raise SystemExit(1)
