from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass


class ResponseTransportError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class StreamRequest:
    endpoint: str
    headers: tuple[tuple[str, str], ...]
    payload: bytes
    timeout_seconds: float


def response_error_message(event) -> str:
    response = event.get("response")
    if isinstance(response, dict):
        error = response.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()
    message = event.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    return "Responses API stream failed"


def completed_response(event):
    event_type = event.get("type")
    if event_type == "response.completed":
        response = event.get("response")
        if not isinstance(response, dict):
            raise ResponseTransportError("response.completed has no response object")
        return response
    if event_type in {"response.failed", "error"}:
        raise ResponseTransportError(response_error_message(event))
    return None


def parse_sse(response):
    data_lines: list[str] = []
    for raw_line in response:
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
            continue
        if line or not data_lines:
            continue
        data = "\n".join(data_lines)
        data_lines.clear()
        if data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError as error:
            raise ResponseTransportError("Responses API returned invalid SSE JSON") from error
        if not isinstance(event, dict):
            raise ResponseTransportError("Responses API returned an invalid SSE event")
        completed = completed_response(event)
        if completed is not None:
            return completed
    raise ResponseTransportError("Responses API stream ended before response.completed")


def request_stream(stream_request: StreamRequest):
    request_headers = dict(stream_request.headers)
    request_headers["Accept"] = "text/event-stream"
    request = urllib.request.Request(
        stream_request.endpoint,
        data=stream_request.payload,
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=stream_request.timeout_seconds
        ) as response:
            if response.headers.get_content_type() == "text/event-stream":
                return parse_sse(response)
            body = response.read()
    except urllib.error.HTTPError as error:
        message = error.read(4096).decode("utf-8", errors="replace").strip()
        for header_name, header_value in stream_request.headers:
            if header_name.lower() == "authorization":
                message = message.replace(header_value, "[REDACTED]")
                message = message.replace(
                    header_value.removeprefix("Bearer "), "[REDACTED]"
                )
        raise ResponseTransportError(
            f"Responses API returned HTTP {error.code}: {message}"
        ) from error
    except urllib.error.URLError as error:
        raise ResponseTransportError(
            f"Responses API request failed: {error.reason}"
        ) from error
    except TimeoutError as error:
        raise ResponseTransportError("Responses API request timed out") from error
    try:
        decoded = json.loads(body)
    except json.JSONDecodeError as error:
        raise ResponseTransportError("Responses API returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise ResponseTransportError("Responses API returned an invalid response object")
    return decoded
