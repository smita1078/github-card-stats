import { fetchMulti } from '../lib/github.js';
import { renderMultiCard, renderErrorCard } from '../lib/render.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const USER_RE = /^[\w-]+$/;
// 8 repos ≈ 24 search calls per uncached render — fits the authenticated
// search limit (30/min). Raise further only with caching in mind.
const MAX_REPOS = 8;

/**
 * Multi-repo card — the URL is the config: list the repos you want, in the
 * order you want them displayed.
 *
 * GET /api/multi?user=<login>&repos=<owner/name>,<owner/name>[&theme=dark]
 */
export default async function handler(req, res) {
  const { user, repos: reposRaw, theme = 'light' } = req.query ?? {};

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');

  const repos = String(reposRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!user || !USER_RE.test(user) || repos.length === 0 || !repos.every((r) => REPO_RE.test(r))) {
    res.status(200).send(
      renderErrorCard('Usage: /api/multi?user=<login>&repos=<owner>/<name>,<owner>/<name>', { theme })
    );
    return;
  }
  if (repos.length > MAX_REPOS) {
    res.status(200).send(renderErrorCard(`Up to ${MAX_REPOS} repos per card`, { theme }));
    return;
  }

  try {
    const data = await fetchMulti({ user, repos, token: process.env.GITHUB_TOKEN });
    const broken = data.rows.some((r) => (r._errors?.length ?? 0) > 0);
    res.setHeader('Cache-Control', broken
      ? 'public, max-age=0, s-maxage=120'
      : 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).send(renderMultiCard(data, { theme }));
  } catch (err) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    res.status(200).send(renderErrorCard('Could not reach the GitHub API — try again shortly', { theme }));
  }
}
