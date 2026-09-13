#!/usr/bin/env python3
"""Validate the published comparison dataset before it goes live.

Run by CI and usable locally:

    python3 tools/validate_results.py web/data/results.json

The site tolerates missing optional fields, but a published document must still honour the
contract in `docs/usage.md`, because a malformed dataset degrades silently in the browser.
Checks, in order:

1. the file parses and `schema_version` is the one the site expects;
2. `algorithms` declares exactly the four algorithm ids in presentation order;
3. every user has a weighted total for each declared algorithm;
4. every score prices every declared algorithm (no unknown keys, no missing ones);
5. `pp` values are finite and non-negative, and `keys` is a plausible column count.

Exit code 0 when the document is publishable, 1 otherwise.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

EXPECTED_SCHEMA_VERSION = 1
EXPECTED_ALGORITHMS = ["bancho", "sunny", "surface", "reimagined"]


def fail(message: str) -> None:
    print(f"✗ {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate_results.py <results.json>")

    path = Path(sys.argv[1])
    if not path.exists():
        fail(f"{path} does not exist")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"{path} is not valid JSON: {exc}")

    if data.get("schema_version") != EXPECTED_SCHEMA_VERSION:
        fail(f"schema_version {data.get('schema_version')!r} != {EXPECTED_SCHEMA_VERSION}")

    ids = [a.get("id") for a in data.get("algorithms", [])]
    if ids != EXPECTED_ALGORITHMS:
        fail(f"algorithms {ids} != {EXPECTED_ALGORITHMS}")

    engine = data.get("engine", {})
    for field in ("name", "version", "spec_version", "rosu_pp_rev"):
        if not engine.get(field):
            fail(f"engine.{field} is missing (the published page must be traceable)")

    users = data.get("users")
    if not isinstance(users, list) or not users:
        fail("no users in the document")

    total_scores = 0
    for user in users:
        uid = user.get("uid")
        totals = user.get("total_pp") or {}
        missing = [i for i in EXPECTED_ALGORITHMS if i not in totals]
        if missing:
            fail(f"user {uid} has no total_pp for {missing}")

        scores = user.get("scores")
        if not isinstance(scores, list):
            fail(f"user {uid} has no scores array")
        total_scores += len(scores)

        for score in scores:
            bid = score.get("beatmap_id")
            pp = score.get("pp") or {}
            unknown = sorted(set(pp) - set(EXPECTED_ALGORITHMS))
            if unknown:
                fail(f"{uid}/{bid}: unknown algorithm keys {unknown}")
            absent = [i for i in EXPECTED_ALGORITHMS if i not in pp]
            if absent:
                fail(f"{uid}/{bid}: pp is missing {absent}")
            for algo, value in pp.items():
                if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    fail(f"{uid}/{bid}: pp.{algo} is not a finite non-negative number: {value!r}")
            keys = score.get("keys")
            if not isinstance(keys, int) or not 1 <= keys <= 18:
                fail(f"{uid}/{bid}: implausible key count {keys!r}")

    warnings = data.get("warnings") or []
    print(
        f"ok: {len(users)} user(s), {total_scores} score(s), "
        f"{len(warnings)} warning(s), engine {engine['name']} {engine['version']} "
        f"spec {engine['spec_version']} rosu-pp {engine['rosu_pp_rev']}"
    )


if __name__ == "__main__":
    main()
