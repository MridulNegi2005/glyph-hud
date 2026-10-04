import json, sys

for path in sys.argv[1:]:
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                m = json.loads(line).get("message") or {}
            except ValueError:
                continue
            u = m.get("usage")
            if not u or not m.get("model"):
                continue
            cc = u.get("cache_creation") or {}
            print(json.dumps({"type": "assistant", "timestamp": json.loads(line).get("timestamp"), "message": {"id": m.get("id"), "model": m["model"], "usage": {
                k: u.get(k, 0) for k in ("input_tokens", "output_tokens",
                                         "cache_creation_input_tokens", "cache_read_input_tokens")} | {"cache_creation": cc}}}))
