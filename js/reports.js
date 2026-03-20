/**
 * reports.js — Weekly Reports tab
 *
 * Fetches data/weekly_reports/index.json once on tab activation,
 * renders a sidebar list of report cards, and lazy-loads individual
 * YYYY-MM-DD.json files when the user selects a card.
 *
 * The report JSON is produced by scripts/generate_weekly_report.py
 * and committed to the repo every Friday via GitHub Actions.
 */

const REPORTS_INDEX = './data/weekly_reports/index.json';
const REPORTS_BASE  = './data/weekly_reports/';

let indexData      = null;   // cached index
let loadedReports  = {};     // weekEnding → report object cache

// ── Format helpers ─────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function fmtRate(val, decimals = 3) {
  if (val == null) return '—';
  const s = val.toFixed(decimals);
  return s.startsWith('0') ? s.slice(1) : s;
}

function fmtPct(val) {
  if (val == null) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

// ── Sidebar card HTML ──────────────────────────────────────────────────────

function reportCardHtml(meta, isSelected) {
  return `
    <div class="report-card${isSelected ? ' report-card-selected' : ''}"
         data-week="${meta.weekEnding}"
         role="button" tabindex="0"
         aria-label="Report for week ending ${meta.weekEnding}">
      <div class="report-card-date">${formatDate(meta.weekEnding)}</div>
      <div class="report-card-meta">
        ${meta.activePlayers} players active
        &middot; ${meta.totalTransactions} txn${meta.totalTransactions !== 1 ? 's' : ''}
      </div>
    </div>`;
}

// ── Detail view helpers ────────────────────────────────────────────────────

/**
 * Render a leaderboard table for one time window.
 * @param {object} windowData  { hittingHighlights, pitchingHighlights }
 * @param {string} paLabel     e.g. "15"
 * @param {string} ipLabel     e.g. "3.0"
 */
function leaderboardHtml(windowData, paLabel, ipLabel) {
  const topHitters  = (windowData.hittingHighlights  || []).filter(h => h.type === 'top_hitter').slice(0, 5);
  const hrHitters   = (windowData.hittingHighlights  || []).filter(h => h.type === 'hr_highlight').slice(0, 5);
  const topPitchers = (windowData.pitchingHighlights || []).filter(h => h.type === 'top_pitcher').slice(0, 5);

  function hitterRow(h) {
    const s = h.stats || {};
    return `<tr>
      <td class="player-name-cell">${h.player}</td>
      <td>${h.level}</td>
      <td>${s.G ?? '—'}</td>
      <td>${s.PA ?? '—'}</td>
      <td>${s.AVG != null ? fmtRate(s.AVG) : '—'}</td>
      <td>${s.OBP != null ? fmtRate(s.OBP) : '—'}</td>
      <td>${s.SLG != null ? fmtRate(s.SLG) : '—'}</td>
      <td>${s.OPS != null ? fmtRate(s.OPS) : '—'}</td>
    </tr>`;
  }

  function pitcherRow(h) {
    const s = h.stats || {};
    return `<tr>
      <td class="player-name-cell">${h.player}</td>
      <td>${h.level}</td>
      <td>${s.G ?? '—'}</td>
      <td>${s.IP ?? '—'}</td>
      <td>${s.SO ?? '—'}</td>
      <td>${s.ERA != null ? s.ERA.toFixed(2) : '—'}</td>
      <td>${s.SO_BB_PCT != null ? fmtPct(s.SO_BB_PCT) : '—'}</td>
    </tr>`;
  }

  const hitRows = topHitters.length
    ? topHitters.map(hitterRow).join('')
    : `<tr><td colspan="8" class="report-empty-cell">No qualified hitters.</td></tr>`;

  const hrRows = hrHitters.length
    ? hrHitters.map(h => `<li class="report-highlight-item">${h.note}</li>`).join('')
    : '';

  const pitRows = topPitchers.length
    ? topPitchers.map(pitcherRow).join('')
    : `<tr><td colspan="7" class="report-empty-cell">No qualified pitchers.</td></tr>`;

  return `
    <p class="report-threshold-note">Min ${paLabel} PA (hitters) / ${ipLabel} IP (pitchers)</p>

    <h4 class="report-sub-heading">Top Hitters by OPS</h4>
    <div class="table-wrapper">
      <table class="stat-table">
        <thead><tr>
          <th class="name-col">Player</th><th>Level</th>
          <th class="num-col">G</th><th class="num-col">PA</th>
          <th class="num-col">AVG</th><th class="num-col">OBP</th>
          <th class="num-col">SLG</th><th class="num-col">OPS</th>
        </tr></thead>
        <tbody>${hitRows}</tbody>
      </table>
    </div>

    ${hrRows ? `
    <h4 class="report-sub-heading">HR Leaders</h4>
    <ul class="report-highlight-list">${hrRows}</ul>` : ''}

    <h4 class="report-sub-heading">Top Pitchers by K-BB%</h4>
    <div class="table-wrapper">
      <table class="stat-table">
        <thead><tr>
          <th class="name-col">Player</th><th>Level</th>
          <th class="num-col">G</th><th class="num-col">IP</th>
          <th class="num-col">K</th><th class="num-col">ERA</th>
          <th class="num-col">K-BB%</th>
        </tr></thead>
        <tbody>${pitRows}</tbody>
      </table>
    </div>`;
}

function newsHtml(newsItems) {
  if (!newsItems || !newsItems.length) {
    return '<p class="report-empty">No news items found this week.</p>';
  }
  const items = newsItems.slice(0, 15).map(n => {
    const src = n.source ? `<span class="report-news-source"> — ${n.source}</span>` : '';
    return `<li class="report-news-item">
      <a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>${src}
    </li>`;
  }).join('');
  return `<ul class="report-news-list">${items}</ul>`;
}

function transactionsHtml(txns) {
  if (!txns || !txns.length) {
    return '<p class="report-empty">No transactions this week.</p>';
  }
  const rows = txns.slice(0, 20).map(t => `
    <tr>
      <td>${t.date}</td>
      <td class="player-name-cell">${t.player}</td>
      <td>${t.type}</td>
      <td>${t.toTeam}</td>
    </tr>`).join('');
  return `
    <div class="table-wrapper">
      <table class="stat-table">
        <thead><tr>
          <th>Date</th><th class="name-col">Player</th><th>Type</th><th>To</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function reportDetailHtml(report) {
  const { weekStarting, weekEnding, summary, last7, last30, seasonToDate,
          transactions, news } = report;

  const levelStr = Object.entries(summary.levelBreakdown || {})
    .sort((a, b) => b[1] - a[1])
    .map(([lvl, n]) => `${n} at ${lvl}`)
    .join(', ') || 'none';

  const noActivity = summary.activePlayers === 0
    ? `<div class="report-no-activity">
         ⚠️ No players recorded stats this week — off-season or no games played.
       </div>`
    : '';

  return `
    <div class="report-detail-header">
      <h2 class="report-detail-title">
        Week of ${formatDate(weekStarting)} &ndash; ${formatDate(weekEnding)}
      </h2>
      <p class="report-detail-summary">
        ${summary.activePlayers} players active (${levelStr}).
        ${summary.totalTransactions} transaction${summary.totalTransactions !== 1 ? 's' : ''} this week.
      </p>
    </div>

    ${noActivity}

    <section class="report-section">
      <h3 class="report-section-heading">Season to Date</h3>
      ${leaderboardHtml(seasonToDate || {}, '50', '10.0')}
    </section>

    <section class="report-section">
      <h3 class="report-section-heading">Last 30 Days</h3>
      ${leaderboardHtml(last30 || {}, '15', '3.0')}
    </section>

    <section class="report-section">
      <h3 class="report-section-heading">This Week (Last 7 Days)</h3>
      ${leaderboardHtml(last7 || {}, '15', '3.0')}
    </section>

    <section class="report-section">
      <h3 class="report-section-heading">In the News</h3>
      ${newsHtml(news)}
    </section>

    <section class="report-section">
      <h3 class="report-section-heading">Transactions</h3>
      ${transactionsHtml(transactions)}
    </section>`;
}

// ── Data fetching ──────────────────────────────────────────────────────────

async function loadIndex() {
  if (indexData) return indexData;
  const res = await fetch(REPORTS_INDEX);
  if (!res.ok) throw new Error(`Could not load reports index (HTTP ${res.status})`);
  indexData = await res.json();
  return indexData;
}

async function loadReport(weekEnding) {
  if (loadedReports[weekEnding]) return loadedReports[weekEnding];
  const res = await fetch(`${REPORTS_BASE}${weekEnding}.json`);
  if (!res.ok) throw new Error(`Could not load report ${weekEnding} (HTTP ${res.status})`);
  const data = await res.json();
  loadedReports[weekEnding] = data;
  return data;
}

// ── UI actions ─────────────────────────────────────────────────────────────

async function selectReport(weekEnding) {
  const detail      = document.getElementById('report-detail-content');
  const placeholder = document.getElementById('report-detail-placeholder');

  // Show loading state
  detail.hidden = true;
  placeholder.hidden = false;
  placeholder.textContent = 'Loading report…';

  // Highlight selected card
  document.querySelectorAll('.report-card').forEach(el => {
    el.classList.toggle('report-card-selected', el.dataset.week === weekEnding);
  });

  try {
    const report = await loadReport(weekEnding);
    detail.innerHTML = reportDetailHtml(report);
    detail.hidden = false;
    placeholder.hidden = true;
  } catch (err) {
    placeholder.textContent = `Failed to load report: ${err.message}`;
  }
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadReportsTab() {
  const sidebar     = document.getElementById('reports-sidebar');
  const placeholder = document.getElementById('report-detail-placeholder');

  // Already populated — nothing to do
  if (sidebar.dataset.loaded) return;

  placeholder.textContent = 'Loading report list…';

  try {
    const index   = await loadIndex();
    const reports = index.reports ?? [];

    if (!reports.length) {
      sidebar.innerHTML = `
        <p class="report-empty">
          No reports yet.<br/>
          Reports are generated every Friday morning.<br/>
          Check back after the first run!
        </p>`;
      placeholder.textContent = 'No reports available yet.';
      return;
    }

    // Render sidebar cards
    sidebar.innerHTML = reports.map((meta, i) => reportCardHtml(meta, i === 0)).join('');
    sidebar.dataset.loaded = 'true';

    // Wire click + keyboard handlers on each card
    sidebar.querySelectorAll('.report-card').forEach(card => {
      card.addEventListener('click', () => selectReport(card.dataset.week));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectReport(card.dataset.week);
        }
      });
    });

    // Auto-select the most recent report
    if (reports[0]) selectReport(reports[0].weekEnding);

  } catch (err) {
    sidebar.innerHTML = `<p class="report-empty">Error loading reports: ${err.message}</p>`;
    placeholder.textContent = 'Could not load report list.';
  }
}
