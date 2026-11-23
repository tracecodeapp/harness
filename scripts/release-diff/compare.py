#!/usr/bin/env python3
"""Normalize and diff two release-diff raw report sets (tests/test-release-diff-catalog.ts).

usage: compare.py <dir> <base-label> <target-label> [--rerun <dir>] [--out <dir>]

<dir> holds <label>-<language>.json for both labels. Writes, into --out (default <dir>):
  normalized-<label>.json   one record per (language, fixture, mode, case)
  differences.json          every differing record with before/after and an automatic group key
  summary.md                counts and automatic groups (input to the hand-written REPORT.md)
With --rerun, a difference whose rerun (same labels, same case) no longer differs is marked flaky.

Modes compared per case:
  submit     host.evaluateAlgorithm, untraced (the app's Submit)
  run        the interactive Run's initial result list (selected case traced, others untraced)
  run-trace  the traced result of each case (initial for the first case, continuation for the rest)

Compared fields: status, verdict (kind), value (canonical JSON), failure class.
0.17.1 has no `failure` object (it arrived in 0.20.0); its failure class is inferred from
status, timedOut and diagnostic codes (see infer_legacy_failure). The target's class comes from
failure.origin + stage/reason. `origin` (program/limit/provider/not-run/none) is the comparable
level; the finer stage/reason is reported separately because 0.17.1 cannot state it.
"""
import json
import os
import sys
from collections import Counter, defaultdict

LANGS = ['python', 'javascript', 'typescript', 'java', 'cpp', 'csharp']


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def diag_codes(diagnostics):
    return sorted({d.get('code') for d in diagnostics or [] if d.get('severity') == 'error' and d.get('code')})


def first_error(diagnostics, fallback=None):
    for d in diagnostics or []:
        if d.get('severity') == 'error' and d.get('message'):
            return d['message'][:300]
    return (fallback or '')[:300] or None


LIMIT_CODE_HINTS = [
    ('trace-byte', 'trace-byte-limit'), ('single-line', 'single-line-limit'), ('line-limit', 'line-limit'),
    ('line_limit', 'line-limit'), ('trace-limit', 'trace-limit'), ('step', 'trace-limit'),
    ('recursion', 'recursion-limit'), ('memory', 'memory-limit'), ('serializ', 'serialization-limit'),
    ('timeout', 'client-timeout'), ('timed-out', 'client-timeout'),
]


def infer_legacy_failure(case):
    """0.17.1 failure class from what it exposes (status, timedOut, diagnostic codes)."""
    status = case.get('status')
    codes = ' '.join(diag_codes(case.get('diagnostics')) + [str(case.get('traceExitReason') or '')]).lower()
    if status == 'completed':
        return 'none', None
    if status == 'timed-out' or case.get('timedOut'):
        return 'limit', 'client-timeout'
    if status == 'protocol-error':
        return 'provider', 'protocol'
    for hint, reason in LIMIT_CODE_HINTS:
        if hint in codes:
            return 'limit', reason
    if 'provider' in codes or 'infrastructure' in codes or 'worker' in codes:
        return 'provider', 'runtime-failure'
    return 'program', 'runtime'


def target_failure(case):
    status = case.get('status')
    if status == 'completed':
        return 'none', None
    if status == 'not-run':
        nr = case.get('notRun') or {}
        return 'not-run', nr.get('limit')
    failure = case.get('failure')
    if not failure:
        return 'unlabelled', None
    return failure.get('origin'), failure.get('stage') or failure.get('reason')


def failure_class(case, legacy):
    return infer_legacy_failure(case) if legacy else target_failure(case)


def compile_record(evaluation, legacy):
    compile_ = evaluation.get('compile') or {}
    failure = compile_.get('failure')
    if failure and not legacy:
        origin, detail = failure.get('origin'), failure.get('stage') or failure.get('reason')
    elif compile_.get('status') == 'timed-out' or compile_.get('timedOut'):
        origin, detail = 'limit', 'client-timeout'
    elif legacy:
        origin, detail = 'program', None  # 0.17.1 does not say which compile stage failed
    else:
        origin, detail = 'program', 'compile'
    return {
        'status': 'compile-failed', 'verdict': None, 'value': None, 'origin': origin, 'detail': detail,
        'message': first_error(compile_.get('diagnostics'), compile_.get('stderr')),
        'codes': diag_codes(compile_.get('diagnostics')),
    }


def case_record(case, legacy):
    if case is None:
        return {'status': 'missing-case', 'verdict': None, 'value': None, 'origin': 'missing', 'detail': None}
    origin, detail = failure_class(case, legacy)
    verdict = case.get('verdict') or {}
    record = {
        'status': case.get('status'),
        'verdict': verdict.get('kind'),
        'value': canon(case.get('value')) if case.get('hasValue') else None,
        'origin': origin,
        'detail': detail,
        'message': (case.get('failure') or {}).get('message', '')[:300] or first_error(case.get('diagnostics'), case.get('stderr')),
        'codes': diag_codes(case.get('diagnostics')),
    }
    if 'hasTrace' in case:
        record['hasTrace'] = case.get('hasTrace')
    return record


def side_error(side):
    if not isinstance(side, dict):
        return {'status': 'no-result'}
    if side.get('runnerError'):
        return {'status': 'runner-error', 'message': side['runnerError'][:300]}
    if side.get('exception'):
        e = side['exception']
        return {'status': 'exception', 'message': (e.get('message') or '')[:300], 'exceptionTag': e.get('tag') or e.get('name')}
    return None


def blank(err):
    return {'status': err['status'], 'verdict': None, 'value': None, 'origin': err['status'], 'detail': None,
            'message': err.get('message'), 'codes': []}


def normalize(problem, legacy):
    out = {}
    submit = problem.get('submit')
    err = side_error(submit)
    for c in problem['submitCases']:
        if err:
            rec = blank(err)
        elif submit['evaluation']['status'] == 'compile-failed':
            rec = compile_record(submit['evaluation'], legacy)
        else:
            rec = case_record(submit['evaluation']['cases'].get(c['id']), legacy)
        out[('submit', c['id'])] = rec
    run = problem.get('run')
    err = side_error(run)
    run_ids = [c['id'] for c in problem['runCases']]
    for i, cid in enumerate(run_ids):
        if err:
            out[('run', cid)] = blank(err)
            out[('run-trace', cid)] = blank(err)
            continue
        initial = run['initial']
        if initial['status'] == 'compile-failed':
            out[('run', cid)] = compile_record(initial, legacy)
            out[('run-trace', cid)] = compile_record(initial, legacy)
            continue
        out[('run', cid)] = case_record(initial['cases'].get(cid), legacy)
        if i == 0:
            out[('run-trace', cid)] = case_record(initial['cases'].get(cid), legacy)
        elif cid in run.get('continuation', {}):
            cont = run['continuation'][cid]
            out[('run-trace', cid)] = case_record(cont, legacy) if cont.get('status') != 'missing-case' else case_record(None, legacy)
        elif run.get('continuationError'):
            ce = run['continuationError']
            out[('run-trace', cid)] = blank({'status': 'continuation-error', 'message': (ce.get('exception') or {}).get('message')})
        else:
            out[('run-trace', cid)] = blank({'status': 'continuation-missing'})
    return out


def load(dirpath, label):
    reports = {}
    for lang in LANGS:
        path = os.path.join(dirpath, f'{label}-{lang}.json')
        if os.path.exists(path):
            with open(path) as f:
                reports[lang] = json.load(f)
    return reports


PRIMARY = ['status', 'verdict', 'value', 'origin']


def diff_fields(a, b):
    fields = [k for k in PRIMARY if a.get(k) != b.get(k)]
    # A finer failure label only counts when both sides fail with the same origin.
    if (not fields and a.get('origin') == b.get('origin') and a.get('origin') != 'none'
            and a.get('detail') is not None and a.get('detail') != b.get('detail')):
        fields.append('detail')
    return fields


def group_key(lang, mode, fields, a, b):
    sig = []
    for f in fields:
        if f == 'value':
            sig.append('value')
        else:
            sig.append(f'{f}:{a.get(f)}->{b.get(f)}')
    return f'{mode} | ' + '; '.join(sig)


def compare(dirpath, base, target, legacy_base=True):
    breports, treports = load(dirpath, base), load(dirpath, target)
    norm = {base: {}, target: {}}
    counts = {}
    diffs = []
    not_compared = []
    for lang in LANGS:
        if lang not in breports or lang not in treports:
            if lang in breports or lang in treports:
                not_compared.append({'language': lang, 'reason': 'only one side has a report'})
            continue
        bp = {p['id']: p for p in breports[lang]['problems']}
        tp = {p['id']: p for p in treports[lang]['problems']}
        for side, rep in ((base, breports[lang]), (target, treports[lang])):
            if not rep.get('complete'):
                not_compared.append({'language': lang, 'reason': f'{side} report incomplete ({len(rep["problems"])} fixtures)'})
            for m in rep.get('missingReferences', []):
                not_compared.append({'language': lang, 'reason': f'{side} missing reference', **m})
        for fid in sorted(set(bp) | set(tp)):
            if fid not in bp or fid not in tp:
                not_compared.append({'language': lang, 'fixture': fid, 'reason': 'fixture ran on one side only'})
                continue
            catalog = bp[fid]['catalog']
            nb = normalize(bp[fid], legacy_base)
            nt = normalize(tp[fid], False)
            for key in sorted(set(nb) | set(nt)):
                mode, cid = key
                a, b = nb.get(key), nt.get(key)
                norm[base].setdefault(lang, {}).setdefault(fid, {})[f'{mode}/{cid}'] = a
                norm[target].setdefault(lang, {}).setdefault(fid, {})[f'{mode}/{cid}'] = b
                c = counts.setdefault((lang, catalog, mode), {'cases': 0, 'differ': 0})
                c['cases'] += 1
                if a is None or b is None:
                    not_compared.append({'language': lang, 'fixture': fid, 'mode': mode, 'case': cid, 'reason': 'case on one side only'})
                    continue
                fields = diff_fields(a, b)
                trace_note = mode == 'run-trace' and a.get('hasTrace') != b.get('hasTrace')
                if fields or trace_note:
                    if fields:
                        c['differ'] += 1
                    diffs.append({
                        'language': lang, 'catalog': catalog, 'fixture': fid, 'mode': mode, 'case': cid,
                        'fields': fields or ['hasTrace'],
                        'group': group_key(lang, mode, fields, a, b) if fields else f'{mode} | hasTrace:{a.get("hasTrace")}->{b.get("hasTrace")}',
                        'base': a, 'target': b,
                    })
    return norm, counts, diffs, not_compared


def main(argv):
    args = [a for a in argv[1:]]
    out = None
    rerun = None
    if '--out' in args:
        i = args.index('--out'); out = args[i + 1]; del args[i:i + 2]
    if '--rerun' in args:
        i = args.index('--rerun'); rerun = args[i + 1]; del args[i:i + 2]
    dirpath, base, target = args
    out = out or dirpath
    norm, counts, diffs, not_compared = compare(dirpath, base, target)
    if rerun:
        _, _, rdiffs, _ = compare(rerun, base, target)
        rkeys = {(d['language'], d['fixture'], d['mode'], d['case'], tuple(d['fields'])) for d in rdiffs}
        rfixtures = set()
        for lang in LANGS:
            for label in (base, target):
                p = os.path.join(rerun, f'{label}-{lang}.json')
                if os.path.exists(p):
                    with open(p) as f:
                        rfixtures |= {(lang, x['id']) for x in json.load(f)['problems']}
        for d in diffs:
            k = (d['language'], d['fixture'], d['mode'], d['case'], tuple(d['fields']))
            if (d['language'], d['fixture']) not in rfixtures:
                d['rerun'] = 'not-rerun'
            elif k in rkeys:
                d['rerun'] = 'reproduced'
            else:
                d['rerun'] = 'did-not-reproduce'
    os.makedirs(out, exist_ok=True)
    for label in (base, target):
        with open(os.path.join(out, f'normalized-{label}.json'), 'w') as f:
            json.dump(norm[label], f, indent=1, sort_keys=True)
    with open(os.path.join(out, 'differences.json'), 'w') as f:
        json.dump({'base': base, 'target': target, 'differences': diffs, 'notCompared': not_compared}, f, indent=1)
    lines = [f'# Release diff {base} -> {target} (automatic summary)', '', '| language | catalog | mode | cases | differ |', '|---|---|---|---:|---:|']
    for (lang, catalog, mode), c in sorted(counts.items()):
        lines.append(f'| {lang} | {catalog} | {mode} | {c["cases"]} | {c["differ"]} |')
    groups = defaultdict(list)
    for d in diffs:
        groups[(d['language'], d['group'])].append(d)
    lines += ['', '## Automatic groups', '']
    for (lang, g), items in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        fixtures = Counter(d['fixture'] for d in items)
        rr = Counter(d.get('rerun', '-') for d in items)
        lines.append(f'- **{lang}** `{g}`: {len(items)} cases in {len(fixtures)} fixtures; rerun {dict(rr)}')
        for d in items[:3]:
            a, b = d['base'], d['target']
            lines.append(f'  - `{d["fixture"]}` {d["case"]}: {a.get("status")}/{a.get("verdict")}/{a.get("origin")}:{a.get("detail")} '
                         f'v={str(a.get("value"))[:80]} -> {b.get("status")}/{b.get("verdict")}/{b.get("origin")}:{b.get("detail")} '
                         f'v={str(b.get("value"))[:80]}; msg {str(a.get("message"))[:100]!r} -> {str(b.get("message"))[:100]!r}')
    lines += ['', '## Not compared', '']
    nc = Counter(n['reason'] if 'missing reference' not in n['reason'] else n['reason'] for n in not_compared)
    for reason, n in nc.most_common():
        lines.append(f'- {reason}: {n}')
    with open(os.path.join(out, 'summary.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines[:60]))
    print(f'... {len(diffs)} difference records; full summary in {os.path.join(out, "summary.md")}')


if __name__ == '__main__':
    main(sys.argv)
