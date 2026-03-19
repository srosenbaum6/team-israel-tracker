/**
 * tables.js — Table rendering, sorting, and filtering
 */

const BBREF_BASE     = 'https://www.baseball-reference.com/players';
const BBREF_REG_BASE = 'https://www.baseball-reference.com/register/player.fcgi';

// ── Display helpers ────────────────────────────────────────────────────────

function fmt(val, decimals) {
  if (val == null) return '—';
  if (typeof val === 'string' && val === '—') return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return n.toFixed(decimals);
}

function fmtPct(val) {
  if (val == null) return '—';
  return (val * 100).toFixed(1) + '%';
}

function levelBadge(level) {
  if (!level) return '<span class="badge badge-Other">—</span>';
  const cls = {
    MLB:  'badge-MLB',
    AAA:  'badge-AAA',
    AA:   'badge-AA',
    'A+': 'badge-Aplus',
    A:    'badge-A',
    MiLB: 'badge-MiLB',
    Indy: 'badge-Indy',
    FA:   'badge-FA',
  }[level] || 'badge-Other';
  return `<span class="badge ${cls}">${level}</span>`;
}

/**
 * Build a player name link.
 * Prefers the MLB BBRef player page (bbrefId), falls back to the
 * BBRef register page (bbrefRegId) for minor-league-only players.
 */
function playerLink(name, bbrefId, bbrefRegId) {
  if (bbrefId) {
    const letter = bbrefId[0];
    const href = `${BBREF_BASE}/${letter}/${bbrefId}.shtml`;
    return `<a href="${href}" target="_blank" rel="noopener">${name}</a>`;
  }
  if (bbrefRegId) {
    const href = `${BBREF_REG_BASE}?id=${bbrefRegId}`;
    return `<a href="${href}" target="_blank" rel="noopener">${name}</a>`;
  }
  return `<span>${name}</span>`;
}

// ── Hitting row → HTML ─────────────────────────────────────────────────────

export function hittingRowHtml(row) {
  return `
    <tr data-org-level="${row.orgLevel ?? ''}" data-played-level="${row.highestLevel ?? ''}" data-type="hitting" data-name="${row.name.toLowerCase()}">
      <td class="player-name-cell">${playerLink(row.name, row.bbrefId, row.bbrefRegId)}</td>
      <td>${row.team}</td>
      <td>${levelBadge(row.orgLevel)}</td>
      <td>${levelBadge(row.highestLevel)}</td>
      <td class="num-col">${row.G       ?? '—'}</td>
      <td class="num-col">${row.PA      ?? '—'}</td>
      <td class="num-col">${row.AB      ?? '—'}</td>
      <td class="num-col">${row.H       ?? '—'}</td>
      <td class="num-col">${row.doubles ?? '—'}</td>
      <td class="num-col">${row.triples ?? '—'}</td>
      <td class="num-col">${row.HR      ?? '—'}</td>
      <td class="num-col">${row.RBI     ?? '—'}</td>
      <td class="num-col">${row.BB      ?? '—'}</td>
      <td class="num-col">${row.SO      ?? '—'}</td>
      <td class="num-col">${row.SB      ?? '—'}</td>
      <td class="num-col">${fmt(row.AVG, 3)}</td>
      <td class="num-col">${fmt(row.OBP, 3)}</td>
      <td class="num-col">${fmt(row.SLG, 3)}</td>
      <td class="num-col">${fmt(row.OPS, 3)}</td>
      <td class="num-col">${fmtPct(row.SOPct)}</td>
      <td class="num-col">${fmtPct(row.BBPct)}</td>
    </tr>`.trim();
}

// ── Pitching row → HTML ────────────────────────────────────────────────────

export function pitchingRowHtml(row) {
  return `
    <tr data-org-level="${row.orgLevel ?? ''}" data-played-level="${row.highestLevel ?? ''}" data-type="pitching" data-name="${row.name.toLowerCase()}">
      <td class="player-name-cell">${playerLink(row.name, row.bbrefId, row.bbrefRegId)}</td>
      <td>${row.team}</td>
      <td>${levelBadge(row.orgLevel)}</td>
      <td>${levelBadge(row.highestLevel)}</td>
      <td class="num-col">${row.G   ?? '—'}</td>
      <td class="num-col">${row.GS  ?? '—'}</td>
      <td class="num-col">${row.IP  != null ? parseFloat(row.IP).toFixed(1) : '—'}</td>
      <td class="num-col">${row.W   ?? '—'}</td>
      <td class="num-col">${row.L   ?? '—'}</td>
      <td class="num-col">${row.H   ?? '—'}</td>
      <td class="num-col">${row.ER  ?? '—'}</td>
      <td class="num-col">${row.BB  ?? '—'}</td>
      <td class="num-col">${row.SO  ?? '—'}</td>
      <td class="num-col">${fmt(row.ERA,  2)}</td>
      <td class="num-col">${fmt(row.WHIP, 2)}</td>
      <td class="num-col">${fmt(row.K9,   2)}</td>
      <td class="num-col">${fmt(row.BB9,  2)}</td>
    </tr>`.trim();
}

// ── Transaction row → HTML ─────────────────────────────────────────────────

export function transactionRowHtml(txn, rosterMap) {
  const player  = rosterMap[txn.mlbId];
  const bbrefId    = player?.bbrefId    ?? null;
  const bbrefRegId = player?.bbrefRegId ?? null;
  const displayDate = txn.date ? txn.date.slice(0, 10) : '—';
  return `
    <tr data-name="${txn.player.toLowerCase()}">
      <td>${displayDate}</td>
      <td class="player-name-cell">${playerLink(txn.player, bbrefId, bbrefRegId)}</td>
      <td>${txn.type}</td>
      <td>${txn.fromTeam}</td>
      <td>${txn.toTeam}</td>
      <td class="desc-col">${txn.description || '—'}</td>
    </tr>`.trim();
}

// ── Populate a table body ──────────────────────────────────────────────────

export function populateTable(tableId, htmlRows, emptyMessage = 'No data available.') {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.querySelector('tbody');
  const colCount = table.querySelector('thead tr')?.children.length ?? 6;

  if (!htmlRows.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-row">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = htmlRows.join('');
}

// ── Sorting ────────────────────────────────────────────────────────────────

export function initSort(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  table.querySelectorAll('th.sortable-col').forEach((th, colIndex) => {
    th.addEventListener('click', () => {
      const isDesc = th.classList.contains('sort-desc');
      table.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(isDesc ? 'sort-asc' : 'sort-desc');
      sortTableByColumn(table, colIndex, !isDesc);
    });
  });
}

function sortTableByColumn(table, colIndex, descending) {
  const tbody = table.querySelector('tbody');
  const rows  = Array.from(tbody.querySelectorAll('tr:not([hidden])'));

  rows.sort((a, b) => {
    const aText = a.cells[colIndex]?.textContent.trim() ?? '';
    const bText = b.cells[colIndex]?.textContent.trim() ?? '';

    if (aText === '—' && bText === '—') return 0;
    if (aText === '—') return 1;
    if (bText === '—') return -1;

    const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''));
    const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''));
    const isNumeric = !isNaN(aNum) && !isNaN(bNum);

    let cmp = isNumeric ? (aNum - bNum) : aText.localeCompare(bText);
    return descending ? -cmp : cmp;
  });

  rows.forEach(r => tbody.appendChild(r));
}

// ── Filtering ──────────────────────────────────────────────────────────────

export function applyFilters() {
  const orgVal    = document.querySelector('[data-filter="orgLevel"].active')?.dataset.value    ?? 'all';
  const playedVal = document.querySelector('[data-filter="playedLevel"].active')?.dataset.value ?? 'all';
  const typeVal   = document.querySelector('[data-filter="type"].active')?.dataset.value         ?? 'all';
  const searchVal = (document.getElementById('playerSearch')?.value ?? '').toLowerCase().trim();

  document.querySelectorAll('.stat-table').forEach(table => {
    if (table.id === 'tbl-transactions') return;

    table.querySelectorAll('tbody tr').forEach(row => {
      const rowOrg    = row.dataset.orgLevel    ?? '';
      const rowPlayed = row.dataset.playedLevel ?? '';
      const rowType   = row.dataset.type        ?? '';
      const rowName   = row.dataset.name        ?? '';

      const orgOk    = orgVal    === 'all' || rowOrg    === orgVal;
      const playedOk = playedVal === 'all' || rowPlayed === playedVal;
      const typeOk   = typeVal   === 'all' || rowType   === typeVal;
      const searchOk = !searchVal || rowName.includes(searchVal);

      row.hidden = !(orgOk && playedOk && typeOk && searchOk);
    });
  });
}

export function applyTxnSearch(searchVal) {
  const q = searchVal.toLowerCase().trim();
  document.querySelectorAll('#tbl-transactions tbody tr').forEach(row => {
    const name = row.dataset.name ?? '';
    row.hidden = q ? !name.includes(q) : false;
  });
}

export function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.filter;
      document.querySelectorAll(`[data-filter="${group}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    });
  });

  const searchInput = document.getElementById('playerSearch');
  if (searchInput) searchInput.addEventListener('input', applyFilters);

  const txnSearch = document.getElementById('txnSearch');
  if (txnSearch) txnSearch.addEventListener('input', () => applyTxnSearch(txnSearch.value));
}
