"""Summarise a .cpuprofile: self time by function and by file. Usage: python probe-cpu.py boot.cpuprofile"""
import collections
import json
import sys

p = json.load(open(sys.argv[1], encoding="utf-8"))
nodes = {n["id"]: n for n in p["nodes"]}
self_t = collections.Counter()
for s, dt in zip(p["samples"], p["timeDeltas"]):
    self_t[s] += dt


def short(url: str) -> str:
    url = url.replace("\\", "/")
    i = url.find("nimbus/")
    return url[i + 7:] if i >= 0 else url


agg = collections.Counter()
for nid, t in self_t.items():
    cf = nodes[nid]["callFrame"]
    agg[(cf["functionName"] or "(anon)", short(cf["url"]), cf.get("lineNumber", 0) + 1)] += t
total = sum(self_t.values()) / 1000
print(f"total sampled {total:.0f} ms over {len(p['samples'])} samples")
for (fn, url, line), t in agg.most_common(30):
    print(f"{t / 1000:7.1f} ms  {fn}  {url}:{line}")
byfile = collections.Counter()
for (fn, url, line), t in agg.items():
    byfile[url] += t
print("--- by file")
for url, t in byfile.most_common(15):
    print(f"{t / 1000:7.1f} ms  {url}")
