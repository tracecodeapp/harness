"""GA and GB deltas for the C-CPP lane validation (validate.sh step `compare`).

GA: every ID of the lane pin against the step-7 pin (same gate, same run), with
the step-7 app fixtures taken as all-pass (2,522 IDs, harness-artifacts
ga-adapt-455b1ef6 app-delta.json). GB: every ID against the step-7 pin.
Writes OUT/compare.json and prints a summary.
"""
import collections
import json
import os
import sys

out = sys.argv[1]
ev = os.path.join(out, 'evidence')


def ga_statuses(name):
    base = os.path.join(ev, 'ga-' + name)
    summary = json.load(open(os.path.join(base, 'summary.json')))
    statuses = {}
    for line in open(os.path.join(base, 'assertions.jsonl')):
        row = json.loads(line)
        statuses[row['id']] = row['status']
    for key in summary.get('missing', []):
        statuses.setdefault(key, 'missing')
    return statuses, summary.get('counts')


def gb_statuses(name):
    base = os.path.join(ev, 'gb-' + name)
    report = json.load(open(os.path.join(base, next(f for f in os.listdir(base) if f.startswith('gb-') and f.endswith('.json')))))
    statuses = {}
    for phase in report['phases']:
        for receipt in phase.get('receipts', []):
            statuses[receipt['id']] = receipt['status']
        for key in phase.get('missing', []):
            statuses[key if isinstance(key, str) else key.get('id')] = 'missing'
        for key in phase.get('step8Owned', []):
            statuses[key if isinstance(key, str) else key.get('id')] = 'step8-owned'
    return statuses, report.get('byLanguage')


def delta(new, old, app_baseline_pass=False):
    flips = collections.Counter()
    examples = {}
    for key in sorted(set(new) | set(old)):
        before = old.get(key)
        if before is None and app_baseline_pass and '/app-' in key:
            before = 'pass'
        before = before or 'absent'
        after = new.get(key, 'absent')
        if before != after:
            family = '/'.join(key.split('/')[:3])
            flips[(family, before, after)] += 1
            examples.setdefault(f'{family}|{before}->{after}', []).append(key)
    return flips, examples


report = {}
try:
    lane, lane_counts = ga_statuses('c-cpp-lane')
    base, base_counts = ga_statuses('c-cpp-step7')
    flips, examples = delta(lane, base, app_baseline_pass=True)
    value_ids = {k: v for k, v in lane.items() if '/cpp-value-default/' in k or '/cpp-value-no-default/' in k}
    report['ga'] = {
        'lane_counts': lane_counts, 'step7_counts': base_counts,
        'pass_to_fail': sorted(k for k in set(lane) | set(base)
                               if (base.get(k) or ('pass' if '/app-' in k else None)) == 'pass' and lane.get(k) != 'pass'),
        'value_ids': dict(collections.Counter(value_ids.values())),
        'flips': {f'{f}|{a}->{b}': n for (f, a, b), n in sorted(flips.items())},
        'examples': {k: v[:5] for k, v in examples.items()},
    }
except Exception as error:  # a missing run is reported, not hidden
    report['ga'] = {'error': repr(error)}
try:
    lane, lane_counts = gb_statuses('c-cpp-lane')
    base, base_counts = gb_statuses('c-cpp-step7')
    flips, examples = delta(lane, base)
    report['gb'] = {
        'lane_counts': lane_counts, 'step7_counts': base_counts,
        'pass_to_fail': sorted(k for k in set(lane) | set(base) if base.get(k) == 'passed' and lane.get(k) != 'passed'),
        'flips': {f'{f}|{a}->{b}': n for (f, a, b), n in sorted(flips.items())},
        'examples': {k: v[:5] for k, v in examples.items()},
    }
except Exception as error:
    report['gb'] = {'error': repr(error)}
json.dump(report, open(os.path.join(out, 'compare.json'), 'w'), indent=1)
for gate in ('ga', 'gb'):
    part = report[gate]
    print(gate, json.dumps({k: part.get(k) for k in ('lane_counts', 'step7_counts', 'value_ids', 'error') if k in part}))
    print(f'  pass_to_fail={len(part.get("pass_to_fail", []))}', part.get('pass_to_fail', [])[:20])
    for k, n in part.get('flips', {}).items():
        print(f'  {n:5d} {k}')
sys.exit(1 if report['ga'].get('error') or report['gb'].get('error') else 0)
