#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///

# How to run:
#   python3 responses_image_gen.py --prompt "..." --out output.png

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import sys
import tempfile
import tomllib
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from responses_transport import ResponseTransportError, StreamRequest, request_stream


class ImageGenerationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProviderSettings:
    provider_id: str
    model: str
    endpoint: str
    headers: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class CliArgs:
    codex_home: Path
    prompt: str
    output_path: Path
    timeout_seconds: float
    force: bool


def required_string(value, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ImageGenerationError(f"missing or invalid {field_name}")
    return value.strip()


def string_pairs(value, field_name: str) -> tuple[tuple[str, str], ...]:
    if value is None:
        return ()
    if not isinstance(value, dict):
        raise ImageGenerationError(f"{field_name} must be a TOML table")
    pairs: list[tuple[str, str]] = []
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise ImageGenerationError(f"{field_name} entries must be strings")
        pairs.append((key, item))
    return tuple(pairs)


def read_toml(path: Path):
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except FileNotFoundError as error:
        raise ImageGenerationError(f"Codex config not found: {path}") from error
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ImageGenerationError(f"unable to read Codex config: {error}") from error


def read_auth_key(codex_home: Path) -> str | None:
    auth_path = codex_home / "auth.json"
    if not auth_path.is_file():
        return None
    try:
        with auth_path.open("r", encoding="utf-8") as handle:
            auth = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise ImageGenerationError(f"unable to read Codex auth store: {error}") from error
    if not isinstance(auth, dict):
        raise ImageGenerationError("Codex auth store must contain a JSON object")
    value = auth.get("OPENAI_API_KEY")
    return value.strip() if isinstance(value, str) and value.strip() else None


def responses_endpoint(base_url: str, query_pairs: tuple[tuple[str, str], ...]) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImageGenerationError("provider base_url must be an HTTP(S) URL")
    path = parsed.path.rstrip("/")
    if not path.endswith("/responses"):
        path = f"{path}/responses"
    query = urllib.parse.urlencode(
        [*urllib.parse.parse_qsl(parsed.query, keep_blank_values=True), *query_pairs]
    )
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, query, ""))


def resolve_headers(codex_home: Path, provider) -> tuple[tuple[str, str], ...]:
    headers = dict(string_pairs(provider.get("http_headers"), "http_headers"))
    for header_name, environment_name in string_pairs(
        provider.get("env_http_headers"), "env_http_headers"
    ):
        environment_value = os.environ.get(environment_name, "").strip()
        if environment_value:
            headers[header_name] = environment_value

    bearer_token = ""
    configured_token = provider.get("experimental_bearer_token")
    if isinstance(configured_token, str):
        bearer_token = configured_token.strip()
    env_key = provider.get("env_key")
    if not bearer_token and isinstance(env_key, str) and env_key.strip():
        bearer_token = os.environ.get(env_key.strip(), "").strip()
    if not bearer_token and provider.get("requires_openai_auth") is True:
        bearer_token = read_auth_key(codex_home) or ""
    if not bearer_token:
        bearer_token = os.environ.get("OPENAI_API_KEY", "").strip()

    normalized_names = {name.lower() for name in headers}
    if bearer_token and "authorization" not in normalized_names:
        headers["Authorization"] = f"Bearer {bearer_token}"
    if "authorization" not in {name.lower() for name in headers}:
        raise ImageGenerationError(
            "no provider credential found in config, auth.json, or the configured environment"
        )
    if "content-type" not in {name.lower() for name in headers}:
        headers["Content-Type"] = "application/json"
    if "user-agent" not in {name.lower() for name in headers}:
        headers["User-Agent"] = "CodexPlusPlus/imagegen"
    return tuple(headers.items())


def load_provider(codex_home: Path) -> ProviderSettings:
    config = read_toml(codex_home / "config.toml")
    model = required_string(config.get("model"), "model")
    provider_id = required_string(config.get("model_provider"), "model_provider")
    providers = config.get("model_providers")
    if not isinstance(providers, dict):
        raise ImageGenerationError("model_providers must be a TOML table")
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        raise ImageGenerationError(f"active provider is not configured: {provider_id}")
    wire_api = provider.get("wire_api", "responses")
    if wire_api != "responses":
        raise ImageGenerationError(
            f"active provider uses unsupported wire_api: {wire_api}"
        )
    base_url = required_string(provider.get("base_url"), "provider base_url")
    query_pairs = string_pairs(provider.get("query_params"), "query_params")
    return ProviderSettings(
        provider_id=provider_id,
        model=model,
        endpoint=responses_endpoint(base_url, query_pairs),
        headers=resolve_headers(codex_home, provider),
    )


def request_image(settings: ProviderSettings, prompt: str, timeout_seconds: float):
    return request_stream(
        StreamRequest(
            endpoint=settings.endpoint,
            headers=settings.headers,
            payload=json.dumps(
                {
                    "model": settings.model,
                    "input": prompt,
                    "stream": True,
                    "tools": [{"type": "image_generation", "action": "generate"}],
                }
            ).encode("utf-8"),
            timeout_seconds=timeout_seconds,
        )
    )


def image_result(response) -> tuple[bytes, str]:
    output = response.get("output")
    if not isinstance(output, list):
        raise ImageGenerationError("Responses API response has no output array")
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "image_generation_call":
            continue
        encoded = item.get("result")
        if not isinstance(encoded, str) or not encoded.strip():
            continue
        if encoded.startswith("data:"):
            _, separator, encoded = encoded.partition(",")
            if not separator:
                continue
        try:
            return base64.b64decode(encoded, validate=True), str(item.get("id") or "")
        except (binascii.Error, ValueError) as error:
            raise ImageGenerationError("image_generation_call contains invalid base64") from error
    raise ImageGenerationError("Responses API returned no completed image_generation_call")


def write_image(path: Path, image_bytes: bytes, force: bool) -> Path:
    output_path = path.expanduser().resolve()
    if output_path.exists() and not force:
        raise ImageGenerationError(f"output already exists: {output_path}")
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output_path.parent, delete=False) as handle:
            handle.write(image_bytes)
            temporary_path = Path(handle.name)
        os.replace(temporary_path, output_path)
    except OSError as error:
        raise ImageGenerationError(f"unable to write image: {error}") from error
    return output_path


def parse_args() -> CliArgs:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--timeout-seconds", type=float, default=300.0)
    parser.add_argument("--force", action="store_true")
    parsed = parser.parse_args()
    if parsed.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be greater than zero")
    codex_home = parsed.codex_home or Path(
        os.environ.get("CODEX_HOME", Path.home() / ".codex")
    )
    return CliArgs(
        codex_home=codex_home.expanduser(),
        prompt=parsed.prompt,
        output_path=parsed.out,
        timeout_seconds=parsed.timeout_seconds,
        force=parsed.force,
    )


def main() -> int:
    args = parse_args()
    try:
        settings = load_provider(args.codex_home)
        response = request_image(settings, args.prompt, args.timeout_seconds)
        image_bytes, image_call_id = image_result(response)
        output_path = write_image(args.output_path, image_bytes, args.force)
    except (ImageGenerationError, ResponseTransportError) as error:
        print(json.dumps({"status": "failed", "message": str(error)}), file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "status": "completed",
                "path": str(output_path),
                "model": settings.model,
                "provider": settings.provider_id,
                "response_id": str(response.get("id") or ""),
                "image_call_id": image_call_id,
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
