#!/usr/bin/env node
/**
 * Local preview:
 *   node scripts/preview.js --user smita1078 --repo checkstyle/checkstyle -o card.svg
 *   node scripts/preview.js --fixture fixtures/sample.json --theme dark -o card-dark.svg
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fetchStats, fetchMulti } from '../lib/github.js';
import { renderCard, renderMultiCard } from '../lib/render.js';

function arg(name, fallback = null) {
  const i = process.argv.findIndex((a) => a === `--${name}` || a === `-${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const fixture = arg('fixture');
const theme = arg('theme', 'light');
const out = arg('o') ?? arg('out') ?? 'card.svg';

let svg;
if (fixture) {
  const data = JSON.parse(await readFile(fixture, 'utf8'));
  svg = Array.isArray(data.rows) ? renderMultiCard(data, { theme }) : renderCard(data, { theme });
} else {
  const user = arg('user');
  const repo = arg('repo');
  const repos = arg('repos');
  if (!user || (!repo && !repos)) {
    console.error('Usage: node scripts/preview.js --user <login> --repo <owner>/<name> [--theme dark] [-o file.svg]');
    console.error('   or: node scripts/preview.js --user <login> --repos <o/n>,<o/n>,<o/n>');
    console.error('   or: node scripts/preview.js --fixture fixtures/sample.json');
    process.exit(1);
  }
  if (repos) {
    const data = await fetchMulti({ user, repos: repos.split(','), token: process.env.GITHUB_TOKEN });
    console.log(JSON.stringify(data, null, 2));
    svg = renderMultiCard(data, { theme });
  } else {
    const stats = await fetchStats({ user, repo, token: process.env.GITHUB_TOKEN });
    console.log(JSON.stringify(stats, null, 2));
    svg = renderCard(stats, { theme });
  }
}

await writeFile(out, svg);
console.log(`Wrote ${out}`);
