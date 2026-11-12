import { getTheme } from './theme.js';

const FONT = `system-ui,-apple-system,'Segoe UI',sans-serif`;

export const WIDTH = 480;
export const HEIGHT = 200;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 1284 → 1.3K, keeps small numbers exact. Null → em dash. */
function compact(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function sinceLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `Contributing since ${month} ${d.getUTCFullYear()}`;
}

/** Truncate long label names so the legend never overflows. */
function clip(s, max = 14) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Render the contribution card as a standalone SVG string.
 * Static SVG only — GitHub READMEs strip scripts, so everything must be markup.
 */
export function renderCard(stats, { theme: themeName = 'light' } = {}) {
  const t = getTheme(themeName);
  const pad = 22;

  const tiles = [
    { label: 'PRs merged', value: compact(stats.mergedPRs) },
    { label: 'PRs open', value: compact(stats.openPRs) },
    { label: 'Issues closed', value: compact(stats.closedIssues) },
    { label: 'Commits', value: compact(stats.commits) }
  ];
  const tileW = (WIDTH - pad * 2) / tiles.length;

  const tileSvg = tiles
    .map((tile, i) => {
      const x = pad + i * tileW;
      return `
    <g transform="translate(${x}, 86)">
      <text x="0" y="0" font-family="${FONT}" font-size="26" font-weight="600" fill="${t.inkPrimary}">${esc(tile.value)}</text>
      <text x="0" y="20" font-family="${FONT}" font-size="11.5" fill="${t.inkSecondary}">${esc(tile.label)}</text>
    </g>`;
    })
    .join('');

  // ---- Top-areas segmented bar (thin, 8px, rounded ends, 2px surface gaps) ----
  const segments = [];
  const { top = [], otherCount = 0 } = stats.areas ?? {};
  top.forEach((a, i) => segments.push({ name: a.name, count: a.count, color: t.series[i] }));
  if (otherCount > 0) segments.push({ name: 'Other', count: otherCount, color: t.other });

  let areasSvg = '';
  if (segments.length > 0) {
    const total = segments.reduce((s, x) => s + x.count, 0);
    const barY = 142;
    const barW = WIDTH - pad * 2;
    const gap = 2;
    const minW = 10;

    // proportional widths with a readable minimum
    let widths = segments.map((s) => Math.max(minW, (s.count / total) * (barW - gap * (segments.length - 1))));
    const scale = (barW - gap * (segments.length - 1)) / widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => w * scale);

    let x = pad;
    const rects = segments
      .map((s, i) => {
        const r = `<rect x="${x.toFixed(1)}" y="${barY}" width="${widths[i].toFixed(1)}" height="8" rx="4" fill="${s.color}"><title>${esc(s.name)}: ${s.count} PRs</title></rect>`;
        x += widths[i] + gap;
        return r;
      })
      .join('\n      ');

    let lx = pad;
    const legend = segments
      .map((s) => {
        const label = clip(s.name);
        const item = `
      <circle cx="${lx + 4}" cy="${barY + 26}" r="4" fill="${s.color}"/>
      <text x="${lx + 13}" y="${barY + 30}" font-family="${FONT}" font-size="11" fill="${t.inkSecondary}">${esc(label)}</text>`;
        lx += 13 + label.length * 6.1 + 18;
        return item;
      })
      .join('');

    areasSvg = `
    <text x="${pad}" y="${barY - 8}" font-family="${FONT}" font-size="11" fill="${t.inkMuted}">Top areas (merged PR labels)</text>
    ${rects}
    ${legend}`;
  } else {
    areasSvg = `
    <text x="${pad}" y="150" font-family="${FONT}" font-size="11" fill="${t.inkMuted}">No label data on merged PRs yet</text>`;
  }

  const since = sinceLabel(stats.firstContribution);
  const subtitleParts = [`@${stats.user}`];
  if (since) subtitleParts.push(since);

  const title = `${esc(stats.repo)} — contributions by @${esc(stats.user)}`;

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}">
  <title>${title}</title>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="10" fill="${t.surface}" stroke="${t.border}"/>
  <g>
    <text x="${pad}" y="36" font-family="${FONT}" font-size="16" font-weight="600" fill="${t.inkPrimary}">${esc(stats.repo)}</text>
    <text x="${pad}" y="54" font-family="${FONT}" font-size="12" fill="${t.inkSecondary}">${esc(subtitleParts.join('  ·  '))}</text>
    ${tileSvg}
    ${areasSvg}
  </g>
</svg>`;
}

/**
 * Multi-repo card: one row per repo, columns for PRs merged / issues closed / commits.
 * Repos and their order come straight from the `repos` query param — the embed URL
 * IS the configuration.
 */
export function renderMultiCard({ user, rows }, { theme: themeName = 'light' } = {}) {
  const t = getTheme(themeName);
  const pad = 22;
  const rowH = 40;
  const top = 74;
  const height = top + rows.length * rowH + 14;

  // right-anchored number columns
  const cols = [
    { label: 'PRs merged', x: 320, key: 'mergedPRs' },
    { label: 'Issues', x: 390, key: 'closedIssues' },
    { label: 'Commits', x: 458, key: 'commits' }
  ];

  const colHeads = cols
    .map(
      (c) =>
        `<text x="${c.x}" y="${top - 8}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="${t.inkMuted}">${c.label}</text>`
    )
    .join('\n    ');

  const rowSvg = rows
    .map((r, i) => {
      const y = top + i * rowH;
      const name = clip(r.repo, 34);
      const since = sinceLabel(r.firstContribution);
      const sinceText = since
        ? `<text x="${pad}" y="${y + 29}" font-family="${FONT}" font-size="10" fill="${t.inkMuted}">${esc(since.replace('Contributing since', 'since'))}</text>`
        : '';
      const nums = cols
        .map(
          (c) =>
            `<text x="${c.x}" y="${y + 20}" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="600" style="font-variant-numeric: tabular-nums" fill="${t.inkPrimary}">${esc(compact(r[c.key]))}</text>`
        )
        .join('\n      ');
      const divider =
        i > 0 ? `<line x1="${pad}" y1="${y - 4}" x2="${WIDTH - pad}" y2="${y - 4}" stroke="${t.hairline}" stroke-width="1"/>` : '';
      return `
    ${divider}
    <text x="${pad}" y="${y + 15}" font-family="${FONT}" font-size="13" font-weight="600" fill="${t.inkPrimary}">${esc(name)}</text>
    ${sinceText}
      ${nums}`;
    })
    .join('');

  const title = `Open-source contributions by @${esc(user)}`;

  return `<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}">
  <title>${title}</title>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${t.surface}" stroke="${t.border}"/>
  <text x="${pad}" y="34" font-family="${FONT}" font-size="16" font-weight="600" fill="${t.inkPrimary}">@${esc(user)}</text>
  <text x="${pad}" y="52" font-family="${FONT}" font-size="12" fill="${t.inkSecondary}">Open-source contributions</text>
  ${colHeads}
  ${rowSvg}
</svg>`;
}

/** Small error card so a broken fetch never renders a broken image. */
export function renderErrorCard(message, { theme: themeName = 'light' } = {}) {
  const t = getTheme(themeName);
  return `<svg width="${WIDTH}" height="80" viewBox="0 0 ${WIDTH} 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="contrib-card error">
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="79" rx="10" fill="${t.surface}" stroke="${t.border}"/>
  <text x="22" y="36" font-family="${FONT}" font-size="13" font-weight="600" fill="${t.inkPrimary}">contrib-card</text>
  <text x="22" y="56" font-family="${FONT}" font-size="12" fill="${t.inkSecondary}">${esc(message).slice(0, 80)}</text>
</svg>`;
}
