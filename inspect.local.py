import json
import sys

r = json.load(open(sys.argv[1]))
want = set(sys.argv[2:])
for c in r["cases"]:
    if c["id"] in want:
        print("====", c["id"], c["status"])
        print("candidate:", json.dumps(c.get("candidate"), indent=1, ensure_ascii=False))
print("celld version:", json.dumps(r["environment"], indent=1)[:1500])
