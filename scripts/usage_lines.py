import json
import sys

FIELDS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")

for path in sys.argv[1:]:
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            m = row.get("message")
            if not isinstance(m, dict) or not m.get("model"):
                continue
            u = m.get("usage")
            if not isinstance(u, dict):
                continue
            cc = u.get("cache_creation")
            usage = {k: u.get(k) if isinstance(u.get(k), (int, float)) else 0 for k in FIELDS}
            usage["cache_creation"] = cc if isinstance(cc, dict) else {}
            print(json.dumps({
                "type": "assistant",
                "timestamp": row.get("timestamp"),
                "message": {"id": m.get("id"), "model": m["model"], "usage": usage},
            }))
