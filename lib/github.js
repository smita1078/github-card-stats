/**
 * GitHub data fetcher — everything comes from the public GitHub REST API.
 * Works unauthenticated (low rate limits); set GITHUB_TOKEN for headroom.
 */

const API = 'https://api.github.com';

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'contrib-card',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function gh(path, token) {
  const res = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res;
}

async function searchIssues(q, params, token) {
  const qs = new URLSearchParams({ q, per_page: '1', ...params });
  const res = await gh(`/search/issues?${qs}`, token);
  return res.json();
}

async function searchCount(q, token) {
  const data = await searchIssues(q, {}, token);
  return data.total_count ?? 0;
}

/** Total commits by author via the Link header trick (per_page=1 → last page = count). */
async function commitCount(repo, user, token) {
  const res = await gh(`/repos/${repo}/commits?author=${encodeURIComponent(user)}&per_page=1`, token);
  const link = res.headers.get('link');
  if (!link) {
    const arr = await res.json();
    return Array.isArray(arr) ? arr.length : 0;
  }
  const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return m ? parseInt(m[1], 10) : 1;
}

/** Earliest PR by the user in the repo → "contributing since". */
async function firstContribution(repo, user, token) {
  const data = await searchIssues(
    `repo:${repo} author:${user} is:pr`,
    { sort: 'created', order: 'asc' },
    token
  );
  return data.items?.[0]?.created_at ?? null;
}

const CLOSING_KEYWORD_RE = /(?:\bclos(?:e|es|ed)\b|\bfix(?:es|ed)?\b|\bresolv(?:e|es|ed)\b)[:\s]*#(\d+)/gi;
const ISSUE_TITLE_RE = /^issue\s*#(\d+)/i;

/**
 * Issues the user solved via merged PRs: unique issue numbers referenced by
 * "Issue #N: …" titles (checkstyle convention) or closing keywords
 * ("fixes #N", "closes #N", "resolves #N") in title/body.
 * Walks up to 300 merged PRs (3 search pages).
 */
async function issuesResolvedViaPRs(repo, user, token) {
  const seen = new Set();
  for (let page = 1; page <= 3; page++) {
    const qs = new URLSearchParams({
      q: `repo:${repo} author:${user} is:pr is:merged`,
      per_page: '100',
      page: String(page)
    });
    const res = await gh(`/search/issues?${qs}`, token);
    const data = await res.json();
    const items = data.items ?? [];
    for (const item of items) {
      const tm = ISSUE_TITLE_RE.exec(item.title ?? '');
      if (tm) seen.add(tm[1]);
      const text = `${item.title ?? ''}\n${item.body ?? ''}`;
      for (const m of text.matchAll(CLOSING_KEYWORD_RE)) seen.add(m[1]);
    }
    if (items.length < 100) break;
  }
  return seen.size;
}

/**
 * Three signals for "issues solved", strongest reported:
 * issues assigned to the user and closed; issues resolved via their merged
 * PRs; issues the user authored that are now closed (common in
 * report-then-fix workflows like checkstyle's).
 */
function combineIssueCounts(...counts) {
  if (counts.every((c) => c === null || c === undefined)) return null;
  return Math.max(...counts.map((c) => c ?? 0));
}

/**
 * Total lines added by the user, from the contributor-stats endpoint.
 * Note: GitHub computes this lazily (202 = still computing; retry once) and
 * it only covers a repo's top 100 contributors — outside that, null.
 */
async function linesAdded(repo, user, token) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API}/repos/${repo}/stats/contributors`, { headers: headers(token) });
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, 1800));
      continue;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} for stats/contributors`);
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const mine = data.find((c) => c.author?.login?.toLowerCase() === user.toLowerCase());
    if (!mine) return null;
    const total = mine.weeks.reduce((s, w) => s + (w.a || 0), 0);
    // Repos with >10k commits: GitHub zeroes all a/d values in this endpoint.
    // Zero lines with real commits = that quirk, not a real zero.
    if (total === 0 && (mine.total ?? 0) > 0) return null;
    return total;
  }
  return null; // still computing — next (cached/warmed) request will have it
}

/**
 * Lines added, summed over the user's merged PRs via GraphQL (up to 300 PRs
 * in 3 requests). Works on any repo size; needs a token that supports GraphQL.
 */
async function linesAddedViaPRs(repo, user, token) {
  if (!token) return null;
  const query =
    'query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{... on PullRequest{additions}}}}';
  let after = null;
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { q: `repo:${repo} author:${user} is:pr is:merged`, after } })
    });
    if (!res.ok) throw new Error(`GraphQL ${res.status}`);
    const data = await res.json();
    if (data.errors?.length) throw new Error(`GraphQL: ${data.errors[0].message}`);
    const s = data.data?.search;
    if (!s) return null;
    for (const n of s.nodes ?? []) total += n?.additions ?? 0;
    if (!s.pageInfo?.hasNextPage) break;
    after = s.pageInfo.endCursor;
  }
  return total;
}

/** Prefer the PR-additions sum (works on any repo size); fall back to contributor stats. */
async function linesAddedSmart(repo, user, token) {
  try {
    const viaPRs = await linesAddedViaPRs(repo, user, token);
    if (viaPRs !== null) return viaPRs;
  } catch (e) {
    console.error(`[contrib-card] ${repo} linesAdded GraphQL fallback:`, e?.message ?? e);
  }
  return linesAdded(repo, user, token);
}

function rankAreas(counts) {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([name, count]) => ({ name, count }));
  const otherCount = sorted.slice(3).reduce((s, [, c]) => s + c, 0);
  return { top, otherCount };
}

/**
 * The user's top areas of work, from the best source available:
 * 1. labels on their merged PRs;
 * 2. conventional title prefixes on those PRs ("doc:", "infra:", "minor:", …) — free,
 *    since the PR items are already fetched;
 * 3. labels on the issues they closed (one extra search call).
 */
async function topAreas(repo, user, token) {
  const qs = new URLSearchParams({
    q: `repo:${repo} author:${user} is:pr is:merged`,
    per_page: '100'
  });
  const res = await gh(`/search/issues?${qs}`, token);
  const data = await res.json();
  const items = data.items ?? [];

  // 1. PR labels
  const labelCounts = new Map();
  let labeled = 0;
  for (const item of items) {
    const labels = (item.labels ?? []).map((l) => l.name).filter(Boolean);
    if (labels.length) labeled++;
    for (const name of labels) labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
  }
  if (labelCounts.size > 0) {
    return { ...rankAreas(labelCounts), labeledPRs: labeled, source: 'pr-labels' };
  }

  // 2. Title prefixes ("doc: …", "infra: …"); only trust them if they're a real
  // convention in this repo (≥25% of PRs carry one).
  const prefixCounts = new Map();
  for (const item of items) {
    const m = /^([a-z][a-z-]{1,14}):\s/i.exec(item.title ?? '');
    if (m) {
      const p = m[1].toLowerCase();
      prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
    }
  }
  const prefixed = [...prefixCounts.values()].reduce((a, b) => a + b, 0);
  if (items.length > 0 && prefixed >= Math.max(3, items.length * 0.25)) {
    return { ...rankAreas(prefixCounts), labeledPRs: prefixed, source: 'title-prefixes' };
  }

  // 3. Labels on issues the user closed
  const iqs = new URLSearchParams({
    q: `repo:${repo} assignee:${user} is:issue is:closed`,
    per_page: '100'
  });
  const ires = await gh(`/search/issues?${iqs}`, token);
  const idata = await ires.json();
  // workflow/status labels say nothing about the AREA of work — skip them
  const STATUS_LABELS = new Set([
    'approved', 'duplicate', 'invalid', 'wontfix', "won't fix", 'help wanted',
    'good first issue', 'easy', 'medium', 'hard', 'stale', 'blocked', 'on hold'
  ]);
  const issueCounts = new Map();
  let labeledIssues = 0;
  for (const item of idata.items ?? []) {
    const labels = (item.labels ?? [])
      .map((l) => l.name)
      .filter((n) => n && !STATUS_LABELS.has(n.toLowerCase()));
    if (labels.length) labeledIssues++;
    for (const name of labels) issueCounts.set(name, (issueCounts.get(name) ?? 0) + 1);
  }
  if (issueCounts.size > 0) {
    return { ...rankAreas(issueCounts), labeledPRs: labeledIssues, source: 'issue-labels' };
  }

  // 4. Keyword classification of PR titles — deterministic, free, no AI needed.
  const buckets = [
    ['docs', /\b(docs?|xdocs?|javadoc|documentation|website|readme|typo)\b/i],
    ['tests', /\b(tests?|coverage|suppressions?|regression|IT|UT)\b/],
    ['checks', /\b(checks?|rule|token|violation|indentation|naming)\b/i],
    ['infra/CI', /\b(ci|infra|pipeline|workflows?|releasenotes|teamcity|circleci|actions?|groovy)\b/i],
    ['dependencies', /\b(dependenc(?:y|ies)|bump|upgrade|update .* to)\b/i]
  ];
  const kwCounts = new Map();
  let classified = 0;
  for (const item of items) {
    // split camelCase so "IndentationCheck" matches "indentation" and "check"
    const title = (item.title ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
    for (const [name, re] of buckets) {
      if (re.test(title)) {
        kwCounts.set(name, (kwCounts.get(name) ?? 0) + 1);
        classified++;
        break; // first matching bucket wins
      }
    }
  }
  if (items.length > 0 && classified >= items.length * 0.3) {
    return { ...rankAreas(kwCounts), labeledPRs: classified, source: 'title-keywords' };
  }

  return { top: [], otherCount: 0, labeledPRs: 0, source: 'none' };
}

/**
 * Lighter per-repo summary for the multi-repo card
 * (3 search calls + 1 commits call per repo — no labels, no open PRs).
 */
export async function fetchRepoSummary({ user, repo, token }) {
  const errors = [];
  const soft = (label, p) =>
    p.catch((e) => {
      errors.push(`${label}: ${e?.message ?? e}`);
      console.error(`[contrib-card] ${repo} ${label}:`, e?.message ?? e);
      return null;
    });
  const [mergedPRs, assignedClosed, resolved, authoredClosed, commits, since, lines] = await Promise.all([
    soft('mergedPRs', searchCount(`repo:${repo} author:${user} is:pr is:merged`, token)),
    soft('assignedClosed', searchCount(`repo:${repo} assignee:${user} is:issue is:closed`, token)),
    soft('resolvedViaPRs', issuesResolvedViaPRs(repo, user, token)),
    soft('authoredClosed', searchCount(`repo:${repo} author:${user} is:issue is:closed`, token)),
    soft('commits', commitCount(repo, user, token)),
    soft('since', firstContribution(repo, user, token)),
    soft('linesAdded', linesAddedSmart(repo, user, token))
  ]);
  return {
    repo,
    mergedPRs,
    closedIssues: combineIssueCounts(assignedClosed, resolved, authoredClosed),
    commits,
    firstContribution: since,
    linesAdded: lines,
    _errors: errors,
    _tokenPresent: Boolean(token)
  };
}

/** Summaries for several repos, fetched in parallel, order preserved. */
export async function fetchMulti({ user, repos, token }) {
  const rows = await Promise.all(repos.map((repo) => fetchRepoSummary({ user, repo, token })));
  return { user, rows };
}

/**
 * Fetch all stats for one user × repo pair.
 * Individual failures degrade to null rather than failing the whole card.
 */
export async function fetchStats({ user, repo, token }) {
  const errors = [];
  const soft = (label, p) =>
    p.catch((e) => {
      errors.push(`${label}: ${e?.message ?? e}`);
      console.error(`[contrib-card] ${repo} ${label}:`, e?.message ?? e);
      return null;
    });

  const [mergedPRs, openPRs, assignedClosed, resolved, authoredClosed, commits, since, areas, lines] = await Promise.all([
    soft('mergedPRs', searchCount(`repo:${repo} author:${user} is:pr is:merged`, token)),
    soft('openPRs', searchCount(`repo:${repo} author:${user} is:pr is:open`, token)),
    soft('assignedClosed', searchCount(`repo:${repo} assignee:${user} is:issue is:closed`, token)),
    soft('resolvedViaPRs', issuesResolvedViaPRs(repo, user, token)),
    soft('authoredClosed', searchCount(`repo:${repo} author:${user} is:issue is:closed`, token)),
    soft('commits', commitCount(repo, user, token)),
    soft('since', firstContribution(repo, user, token)),
    soft('areas', topAreas(repo, user, token)),
    soft('linesAdded', linesAddedSmart(repo, user, token))
  ]);

  return {
    user,
    repo,
    mergedPRs,
    openPRs,
    closedIssues: combineIssueCounts(assignedClosed, resolved, authoredClosed),
    commits,
    firstContribution: since,
    linesAdded: lines,
    areas: areas ?? { top: [], otherCount: 0, labeledPRs: 0 },
    _errors: errors,
    _tokenPresent: Boolean(token)
  };
}
