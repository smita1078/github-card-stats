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
    return mine.weeks.reduce((s, w) => s + (w.a || 0), 0);
  }
  return null; // still computing — next (cached/warmed) request will have it
}

/** Top labels across the user's merged PRs (up to 100 most recent). */
async function topAreas(repo, user, token) {
  const qs = new URLSearchParams({
    q: `repo:${repo} author:${user} is:pr is:merged`,
    per_page: '100'
  });
  const res = await gh(`/search/issues?${qs}`, token);
  const data = await res.json();
  const counts = new Map();
  let labeled = 0;
  for (const item of data.items ?? []) {
    const labels = (item.labels ?? []).map((l) => l.name).filter(Boolean);
    if (labels.length) labeled++;
    for (const name of labels) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([name, count]) => ({ name, count }));
  const otherCount = sorted.slice(3).reduce((s, [, c]) => s + c, 0);
  return { top, otherCount, labeledPRs: labeled };
}

/**
 * Lighter per-repo summary for the multi-repo card
 * (3 search calls + 1 commits call per repo — no labels, no open PRs).
 */
export async function fetchRepoSummary({ user, repo, token }) {
  const soft = (p) => p.catch(() => null);
  const [mergedPRs, closedIssues, commits, since, lines] = await Promise.all([
    soft(searchCount(`repo:${repo} author:${user} is:pr is:merged`, token)),
    soft(searchCount(`repo:${repo} assignee:${user} is:issue is:closed`, token)),
    soft(commitCount(repo, user, token)),
    soft(firstContribution(repo, user, token)),
    soft(linesAdded(repo, user, token))
  ]);
  return { repo, mergedPRs, closedIssues, commits, firstContribution: since, linesAdded: lines };
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
  const soft = (p) => p.catch(() => null);

  const [mergedPRs, openPRs, closedIssues, commits, since, areas, lines] = await Promise.all([
    soft(searchCount(`repo:${repo} author:${user} is:pr is:merged`, token)),
    soft(searchCount(`repo:${repo} author:${user} is:pr is:open`, token)),
    soft(searchCount(`repo:${repo} assignee:${user} is:issue is:closed`, token)),
    soft(commitCount(repo, user, token)),
    soft(firstContribution(repo, user, token)),
    soft(topAreas(repo, user, token)),
    soft(linesAdded(repo, user, token))
  ]);

  return {
    user,
    repo,
    mergedPRs,
    openPRs,
    closedIssues,
    commits,
    firstContribution: since,
    linesAdded: lines,
    areas: areas ?? { top: [], otherCount: 0, labeledPRs: 0 }
  };
}
