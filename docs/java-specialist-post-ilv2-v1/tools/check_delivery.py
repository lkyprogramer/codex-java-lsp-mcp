#!/usr/bin/env python3
"""Verify source in an already-serialized request; this is not a task grader or sandbox."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from typing import Any

MAX_BODY = 8 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
MAX_UNITS = 8
MAX_LINES = 80
MAX_BYTES = 16000

class ReceiptError(ValueError):
    """A bounded evidence-delivery contract was violated."""


def strict_loads(value: bytes | str) -> Any:
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ReceiptError('DUPLICATE_JSON_KEY')
            result[key] = item
        return result
    try:
        return json.loads(value, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ReceiptError('NONFINITE_JSON')))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ReceiptError('INVALID_JSON') from exc


def require(value: bool, reason: str) -> None:
    if not value:
        raise ReceiptError(reason)


def pointer(value: Any, address: str) -> Any:
    if address == '':
        return value
    require(address.startswith('/'), 'INVALID_POINTER')
    for encoded in address[1:].split('/'):
        require(not re.search(r'~(?![01])', encoded), 'INVALID_POINTER_ESCAPE')
        key = encoded.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            require(bool(re.fullmatch(r'0|[1-9][0-9]*', key)), 'INVALID_ARRAY_INDEX')
            i = int(key)
            require(i < len(value), 'POINTER_MISSING')
            value = value[i]
        elif isinstance(value, dict):
            require(key in value, 'POINTER_MISSING')
            value = value[key]
        else:
            raise ReceiptError('POINTER_NOT_CONTAINER')
    return value


def bounded_source(root: Path, relative: str) -> bytes:
    require(isinstance(relative, str) and bool(relative), 'INVALID_PATH')
    p = PurePosixPath(relative)
    require(not p.is_absolute() and '\\' not in relative and '\x00' not in relative,
            'INVALID_PATH')
    require(all(part not in ('', '.', '..') for part in relative.split('/')), 'PATH_ESCAPE')
    f = root
    try:
        for part in p.parts:
            f = f / part
            require(not f.is_symlink(), 'SYMLINK_REFUSED')
        require(f.resolve(strict=True).is_relative_to(root), 'PATH_ESCAPE')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(f, flags)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode), 'SOURCE_NOT_REGULAR')
            require(before.st_size <= MAX_FILE, 'SOURCE_FILE_CAP')
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                data = handle.read(MAX_FILE + 1)
            require(len(data) <= MAX_FILE, 'SOURCE_FILE_CAP')
            after = os.fstat(fd)
            current = f.stat()
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            require(identity(before) == identity(after) == identity(current), 'SOURCE_CHANGED')
            require(not f.is_symlink() and f.resolve(strict=True).is_relative_to(root), 'SOURCE_CHANGED')
        finally:
            os.close(fd)
        return data
    except OSError as exc:
        raise ReceiptError('SOURCE_UNAVAILABLE') from exc


def lf_lines(data: bytes) -> list[bytes]:
    """LF is the line separator; preserve CRLF and final-newline bytes exactly."""
    parts = data.split(b'\n')
    return [part + b'\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def check_receipt(body: bytes, receipt: dict, workspace: Path,
                  expected_view: dict) -> dict:
    require(isinstance(body, bytes) and len(body) <= MAX_BODY, 'REQUEST_BODY_CAP')
    require(isinstance(receipt, dict), 'INVALID_RECEIPT')
    require(receipt.get('schema') == 'post-ilv2/evidence-receipt/v1', 'SCHEMA_MISMATCH')
    require(isinstance(expected_view, dict), 'INVALID_EXPECTED_VIEW')
    for key in ('workspaceId', 'contentManifestId'):
        require(isinstance(expected_view.get(key), str) and bool(expected_view[key]), 'MISSING_VIEW')
        require(receipt.get(key) == expected_view[key], 'VIEW_MISMATCH')
    require(receipt.get('requestBodySha256') == hashlib.sha256(body).hexdigest(), 'REQUEST_HASH_MISMATCH')
    request = strict_loads(body)
    require(isinstance(request, dict) and isinstance(request.get('messages'), list), 'NO_MESSAGES')
    units = receipt.get('units')
    require(isinstance(units, list) and 0 < len(units) <= MAX_UNITS, 'UNIT_CAP_OR_EMPTY')
    root = workspace.resolve(strict=True)
    require(root.is_dir(), 'WORKSPACE_NOT_DIRECTORY')
    seen = set()
    total_bytes = total_lines = 0
    for unit in units:
        require(isinstance(unit, dict), 'INVALID_UNIT')
        uid = unit.get('id')
        require(isinstance(uid, str) and bool(uid) and uid not in seen, 'DUPLICATE_OR_MISSING_UNIT_ID')
        seen.add(uid)
        require(unit.get('previewKind') == 'source', 'NOT_SOURCE')
        index = unit.get('messageIndex')
        require(type(index) is int and 0 <= index < len(request['messages']), 'INVALID_MESSAGE_INDEX')
        msg = request['messages'][index]
        require(isinstance(msg, dict) and msg.get('role') == 'tool', 'NOT_TOOL_MESSAGE')
        call_id = unit.get('toolCallId')
        require(isinstance(call_id, str) and bool(call_id) and msg.get('tool_call_id') == call_id,
                'TOOL_CALL_MISMATCH')
        content = msg.get('content')
        require(isinstance(content, str), 'UNSUPPORTED_CONTENT_SHAPE')
        ptr = unit.get('textPointer')
        require(isinstance(ptr, str), 'INVALID_POINTER')
        delivered = content if ptr == '' else pointer(strict_loads(content), ptr)
        require(isinstance(delivered, str), 'SOURCE_NOT_TEXT')
        start, end = unit.get('startLine'), unit.get('endLine')
        require(type(start) is int and type(end) is int and 1 <= start <= end, 'INVALID_RANGE')
        h = unit.get('contentHash')
        require(isinstance(h, str) and bool(re.fullmatch(r'[a-f0-9]{64}', h)), 'INVALID_SOURCE_HASH')
        data = bounded_source(root, unit.get('relativePath'))
        require(hashlib.sha256(data).hexdigest() == h, 'SOURCE_HASH_MISMATCH')
        lines = lf_lines(data)
        require(end <= len(lines), 'RANGE_OUT_OF_BOUNDS')
        expected = b''.join(lines[start-1:end])
        try:
            expected.decode('utf8', errors='strict')
            encoded = delivered.encode('utf8', errors='strict')
        except UnicodeError as exc:
            raise ReceiptError('INVALID_SOURCE_ENCODING') from exc
        require(encoded == expected, 'FINAL_TEXT_MISMATCH')
        total_bytes += len(encoded)
        total_lines += end-start+1
        require(total_bytes <= MAX_BYTES, 'SOURCE_BYTE_BUDGET')
        require(total_lines <= MAX_LINES, 'SOURCE_LINE_BUDGET')
    return {'status': 'REQUEST_BODY_VERIFIED', 'verifiedUnits': len(units),
            'sourceBytes': total_bytes, 'sourceLines': total_lines,
            'networkDelivery': 'NOT_CHECKED', 'modelUse': 'NOT_CHECKED',
            'taskSuccess': 'NOT_CHECKED'}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--request', required=True, type=Path)
    p.add_argument('--receipt', required=True, type=Path)
    p.add_argument('--workspace', required=True, type=Path)
    p.add_argument('--view', required=True, type=Path,
                   help='Evaluator-captured held view with workspaceId/contentManifestId')
    a = p.parse_args()
    try:
        result = check_receipt(a.request.read_bytes(), strict_loads(a.receipt.read_bytes()),
                               a.workspace, strict_loads(a.view.read_bytes()))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ReceiptError as exc:
        print(json.dumps({'status':'REFUSED','reason':str(exc)}))
        return 1
    except (OSError, ValueError, TypeError) as exc:
        print(json.dumps({'status':'INPUT_OR_ENV_ERROR','reason':str(exc)}))
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
