import { fetchStats } from '../lib/github.js';
import { renderCard, renderErrorCard } from '../lib/render.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const USER_RE = /^[\w-]+$/;

/**
 * Vercel serverless function.
 * GET /api/card?user=<github-user>&repo=<owner>/<name>[&theme=dark]
 */
export default async function handler(req, res) {
  const { user, repo, theme = 'light' } = req.query ?? {};

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');

  if (!user || !repo || !USER_RE.test(user) || !REPO_RE.test(repo)) {
    res.status(200).send(renderErrorCard('Usage: /api/card?user=<login>&repo=<owner>/<name>', { theme }));
    return;
  }

  try {
    const stats = await fetchStats({ user, repo, token: process.env.GITHUB_TOKEN });
    if (req.query?.debug === '1') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(JSON.stringify(stats, null, 2));
      return;
    }
    // Cache on the CDN for 6h; serve stale while revalidating so embeds stay fast.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).send(renderCard(stats, { theme }));
  } catch (err) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    res.status(200).send(renderErrorCard('Could not reach the GitHub API — try again shortly', { theme }));
  }
}
