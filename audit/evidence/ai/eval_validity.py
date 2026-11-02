"""Phase 4 eval-validity checks. Pure stdlib, no network, deterministic (seeded).
Reads frozen evals/hireflow_v1/cases.jsonl + evals/results/offline.json.
Outputs JSON to stdout."""
import json, math, random, re, collections, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
cases = [json.loads(l) for l in open(f'{ROOT}/evals/hireflow_v1/cases.jsonl')]
off = json.load(open(f'{ROOT}/evals/results/offline.json'))
rk = [c for c in cases if c['kind'] == 'ranking']
pq = {q['id']: q for q in off['ranking']['per_query']}

def metrics(rel_in_order, k=3):
    relevant = sum(1 for r in rel_in_order if r >= 2)
    sel = rel_in_order[:k]
    dcg = lambda rows: sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(rows))
    ideal = dcg(sorted(rel_in_order, reverse=True)[:k])
    return dict(r1=(sum(1 for r in rel_in_order[:1] if r >= 2) / relevant) if relevant else 0,
                r3=(sum(1 for r in sel if r >= 2) / relevant) if relevant else 0,
                ndcg3=dcg(sel) / ideal if ideal else 0)

tok = lambda s: re.findall(r"[a-z0-9+#.]+", s.lower())
STOP = set('a an the to of and or for with in on at by as is are be use using this that your you we our help build built required expertise professional position focuses'.split())
def terms(s): return [t for t in tok(s) if t not in STOP and len(t) > 2]
def profile_text(p):
    return ' '.join([p.get('summary', '')] + [f"{x['name']} {x['description']} {' '.join(x['tech'])}" for x in p['projects']])
def tfidf_rank(case):
    docs = [terms(c['description']) for c in case['candidates']]
    q = terms(profile_text(case['profile']))
    df = collections.Counter(t for d in docs for t in set(d))
    N = len(docs)
    idf = lambda t: math.log((N + 1) / (df.get(t, 0) + 0.5))
    def vec(ts):
        c = collections.Counter(ts); return {t: (1 + math.log(n)) * idf(t) for t, n in c.items()}
    qv = vec(q)
    def cos(a, b):
        num = sum(a[t] * b.get(t, 0) for t in a)
        da = math.sqrt(sum(v * v for v in a.values())); db = math.sqrt(sum(v * v for v in b.values()))
        return num / (da * db) if da and db else 0
    scores = [(cos(qv, vec(d)), -i) for i, d in enumerate(docs)]
    order = sorted(range(N), key=lambda i: scores[i], reverse=True)
    return [case['candidates'][i]['relevance'] for i in order]
def bm25_rank(case, k1=1.5, b=0.75):
    docs = [terms(c['description']) for c in case['candidates']]
    q = set(terms(profile_text(case['profile'])))
    N = len(docs); avg = sum(map(len, docs)) / N
    df = collections.Counter(t for d in docs for t in set(d))
    def sc(d):
        c = collections.Counter(d); s = 0
        for t in q:
            if t in c:
                idf = math.log(1 + (N - df[t] + .5) / (df[t] + .5))
                s += idf * c[t] * (k1 + 1) / (c[t] + k1 * (1 - b + b * len(d) / avg))
        return s
    order = sorted(range(N), key=lambda i: (sc(docs[i]), -i), reverse=True)
    return [case['candidates'][i]['relevance'] for i in order]

def rel_from_order(case, order):
    by = {c['id']: c['relevance'] for c in case['candidates']}
    return [by[i] for i in order]

methods = {}
for c in rk:
    q = pq[c['id']]
    m = methods.setdefault(c['id'], {})
    for name in ('lexical', 'semantic', 'hybrid'):
        m[name] = metrics(rel_from_order(c, q[name]['order']))
    m['tfidf'] = metrics(tfidf_rank(c))
    m['bm25'] = metrics(bm25_rank(c))
    m['oracle_shuffle_mean'] = None
    # random-order expectation over all 120 permutations
    import itertools
    rels = [x['relevance'] for x in c['candidates']]
    perms = list(itertools.permutations(rels)); n = len(perms)
    agg = collections.Counter()
    for p in perms:
        mm = metrics(list(p))
        for k, v in mm.items(): agg[k] += v / n
    m['random'] = dict(agg)

def mean(xs): xs = list(xs); return sum(xs) / len(xs)
def agg(split, name, key):
    return mean(methods[c['id']][name][key] for c in rk if c['split'] == split)

out = {'n_ranking_queries': len(rk), 'groups': {s: sorted({c['group'] for c in rk if c['split'] == s}) for s in ('dev', 'heldout')}}
out['group_overlap_dev_heldout'] = sorted(set(out['groups']['dev']) & set(out['groups']['heldout']))
out['heldout_means'] = {n: {k: round(agg('heldout', n, k), 4) for k in ('r1', 'r3', 'ndcg3')} for n in ('random', 'lexical', 'tfidf', 'bm25', 'semantic', 'hybrid')}
out['dev_means'] = {n: {k: round(agg('dev', n, k), 4) for k in ('r1', 'r3', 'ndcg3')} for n in ('random', 'lexical', 'tfidf', 'bm25', 'semantic', 'hybrid')}

# Bootstrap: resample *groups* (domain clusters) since the two mode variants share a domain.
rng = random.Random(20261102)
held = [c for c in rk if c['split'] == 'heldout']
byg = collections.defaultdict(list)
for c in held: byg[c['group']].append(c['id'])
G = list(byg)
def boot(fn, B=10000, cluster=True):
    vals = []
    for _ in range(B):
        if cluster:
            ids = [i for g in (rng.choice(G) for _ in G) for i in byg[g]]
        else:
            ids = [rng.choice(held)['id'] for _ in held]
        vals.append(fn(ids))
    vals.sort(); return [round(vals[int(.025 * B)], 4), round(vals[int(.975 * B)], 4)]
def m_of(name, key): return lambda ids: mean(methods[i][name][key] for i in ids)
def diff(a, b, key): return lambda ids: mean(methods[i][a][key] - methods[i][b][key] for i in ids)
ci = {}
for name in ('lexical', 'tfidf', 'bm25', 'semantic', 'hybrid'):
    ci[name] = {k: {'point': round(m_of(name, k)([c['id'] for c in held]), 4), 'ci95_cluster': boot(m_of(name, k)), 'ci95_query': boot(m_of(name, k), cluster=False)} for k in ('ndcg3', 'r1')}
out['bootstrap_heldout'] = ci
paired = {}
for a, b in (('hybrid', 'lexical'), ('hybrid', 'tfidf'), ('hybrid', 'bm25'), ('hybrid', 'semantic'), ('semantic', 'tfidf')):
    paired[f'{a}-{b}'] = {k: {'point': round(diff(a, b, k)([c['id'] for c in held]), 4), 'ci95_cluster': boot(diff(a, b, k))} for k in ('ndcg3', 'r1')}
out['paired_diff_heldout'] = paired
# sign test per group (cluster-level)
def group_wins(a, b):
    w = l = t = 0
    for g, ids in byg.items():
        d = mean(methods[i][a]['ndcg3'] - methods[i][b]['ndcg3'] for i in ids)
        if d > 1e-9: w += 1
        elif d < -1e-9: l += 1
        else: t += 1
    return {'groups': len(byg), 'wins': w, 'losses': l, 'ties': t}
out['group_level_wins_ndcg3'] = {'hybrid_vs_lexical': group_wins('hybrid', 'lexical'), 'hybrid_vs_tfidf': group_wins('hybrid', 'tfidf'), 'semantic_vs_tfidf': group_wins('semantic', 'tfidf')}
# label structure: every query has exactly one 3, one 2, one 1, two 0 (generator-constructed)
out['label_multiset_per_query'] = {str(k): v for k, v in collections.Counter(tuple(sorted((x['relevance'] for x in c['candidates']), reverse=True)) for c in rk).items()}
out['max_recall_at_1_possible'] = 0.5
out['jd_text_templated'] = {'distinct_candidate_descriptions': len({x['description'] for c in rk for x in c['candidates']}), 'total_candidate_slots': sum(len(c['candidates']) for c in rk)}
print(json.dumps(out, indent=1))
