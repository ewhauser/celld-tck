import json
import sys

o = json.load(open("test/case-oracles/observations.json"))
for report, case_id in zip(sys.argv[1::2], sys.argv[2::2]):
    r = json.load(open(report))
    assert not r["environment"]["dirty"], report
    c = next(c for c in r["cases"] if c["id"] == case_id)
    assert c["status"] == "pass", c["status"]
    o["cases"][case_id] = c["reference"]
    entry = {
        "runId": r["runId"],
        "sourceRevision": r["environment"]["sourceRevision"],
    }
    if entry not in o["sources"]:
        o["sources"].append(entry)
    print(case_id, json.dumps(c["reference"]["body"], ensure_ascii=False))
open("test/case-oracles/observations.json", "w").write(
    json.dumps(o, indent=2, ensure_ascii=False) + "\n"
)
