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

/**
 * Format a rate stat (AVG/OBP/SLG/OPS) without a leading zero.
 * ".314" not "0.314". Values >= 1 keep their leading digit: "1.045".
 */
function fmtRate(val, decimals = 3) {
  if (val == null) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  const fixed = n.toFixed(decimals);
  if (n >= 0 && n < 1)   return fixed.replace(/^0/, '');
  if (n > -1 && n < 0)   return fixed.replace(/^-0/, '-');
  return fixed;
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
 * Uses the MLB BBRef player page (bbrefId) for players who have appeared in MLB.
 * Falls back to the BBRef register page (bbrefRegId) for minor-league-only players.
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
// Columns: Player, Org, Current Level, Highest Level,
//          G, PA, AVG, OBP, SLG, OPS, SO%, BB%, 2B, 3B, HR, RBI, SB, CS

export function hittingRowHtml(row) {
  return `
    <tr data-current-level="${row.currentLevel ?? ''}" data-highest-level="${row.careerHighestLevel ?? ''}" data-type="hitting" data-name="${row.name.toLowerCase()}">
      <td class="player-name-cell">${playerLink(row.name, row.bbrefId, row.bbrefRegId)}</td>
      <td>${row.team}</td>
      <td>${levelBadge(row.currentLevel)}</td>
      <td>${levelBadge(row.careerHighestLevel)}</td>
      <td class="num-col">${row.G       ?? '—'}</td>
      <td class="num-col">${row.PA      ?? '—'}</td>
      <td class="num-col">${fmtRate(row.AVG)}</td>
      <td class="num-col">${fmtRate(row.OBP)}</td>
      <td class="num-col">${fmtRate(row.SLG)}</td>
      <td class="num-col">${fmtRate(row.OPS)}</td>
      <td class="num-col">${fmtPct(row.SOPct)}</td>
      <td class="num-col">${fmtPct(row.BBPct)}</td>
      <td class="num-col">${row.doubles ?? '—'}</td>
      <td class="num-col">${row.triples ?? '—'}</td>
      <td class="num-col">${row.HR      ?? '—'}</td>
      <td class="num-col">${row.RBI     ?? '—'}</td>
      <td class="num-col">${row.SB      ?? '—'}</td>
      <td class="num-col">${row.CS      ?? '—'}</td>
    </tr>`.trim();
}

// ── Pitching row → HTML ────────────────────────────────────────────────────
// Columns: Player, Org, Current Level, Highest Level,
//          G, GS, IP, SO%, BB%, SO-BB%, WHIP, ERA

export function pitchingRowHtml(row) {
  return `
    <tr data-current-level="${row.currentLevel ?? ''}" data-highest-level="${row.careerHighestLevel ?? ''}" data-type="pitching" data-name="${row.name.toLowerCase()}">
      <td class="player-name-cell">${playerLink(row.name, row.bbrefId, row.bbrefRegId)}</td>
      <td>${row.team}</td>
      <td>${levelBadge(row.currentLevel)}</td>
      <td>${levelBadge(row.careerHighestLevel)}</td>
      <td class="num-col">${row.G  ?? '—'}</td>
      <td class="num-col">${row.GS ?? '—'}</td>
      <td class="num-col">${row.IP != null ? parseFloat(row.IP).toFixed(1) : '—'}</td>
      <td class="num-col">${fmtPct(row.SOPct)}</td>
      <td class="num-col">${fmtPct(row.BBPct)}</td>
      <td class="num-col">${fmtPct(row.SOBBPct)}</td>
      <td class="num-col">${fmt(row.WHIP, 2)}</td>
      <td class="num-col">${fmt(row.ERA,  2)}</td>
    </tr>`.trim();
}

// ── Transaction row → HTML ─────────────────────────────────────────────────

export function transactionRowHtml(txn, rosterMap) {
  const player     = rosterMap[txn.mlbId];
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
  const tbody    = table.querySelector('tbody');
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

    // Strip % sign and leading dot/dash for numeric comparison
    const clean = t => t.replace('%', '').replace(/^\./, '0.').replace(/^-\./, '-0.');
    const aNum  = parseFloat(clean(aText));
    const bNum  = parseFloat(clean(bText));
    const isNumeric = !isNaN(aNum) && !isNaN(bNum);

    const cmp = isNumeric ? (aNum - bNum) : aText.localeCompare(bText);
    return descending ? -cmp : cmp;
  });

  rows.forEach(r => tbody.appendChild(r));
}

// ── Color coding ───────────────────────────────────────────────────────────

function getRankColor(value, min, max, higherIsBetter) {
  if (min === max) return '';
  const ratio      = (value - min) / (max - min);   // 0 = min val, 1 = max val
  const goodRatio  = higherIsBetter ? ratio : 1 - ratio; // 0 = worst, 1 = best

  let r, g, b;
  if (goodRatio >= 0.5) {
    // White → light red (good)
    const t = (goodRatio - 0.5) * 2;
    r = 255;
    g = Math.round(255 - t * 90);
    b = Math.round(255 - t * 90);
  } else {
    // Light blue → white (bad)
    const t = goodRatio * 2;
    r = Math.round(165 + t * 90);
    g = Math.round(165 + t * 90);
    b = 255;
  }
  return `rgb(${r},${g},${b})`;
}

/**
 * Apply heat-map background colors to stat columns in a table.
 * @param {string}  tableId
 * @param {Object}  colConfig  { colIndex: higherIsBetter (bool) }
 * @param {number}  [paCol]    Column index containing PA; rows below threshold are grayed
 * @param {number}  [paMin=50] PA threshold below which stat cells are grayed
 */
export function colorizeTable(tableId, colConfig, paCol = null, paMin = 50) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) return;

  // Helper: parse a formatted cell value to a float
  function parseCell(text) {
    if (!text || text === '—') return NaN;
    // Handle: "24.3%", ".314", "-.052%", "1.045"
    const cleaned = text
      .replace('%', '')
      .replace(/^\./, '0.')
      .replace(/^-\./, '-0.');
    return parseFloat(cleaned);
  }

  // Collect all values per column (using all rows for a stable color scale)
  const colMins = {}, colMaxes = {};
  for (const colIdx of Object.keys(colConfig)) {
    const vals = rows
      .map(row => parseCell(row.cells[Number(colIdx)]?.textContent?.trim()))
      .filter(v => !isNaN(v));
    if (vals.length) {
      colMins[colIdx]  = Math.min(...vals);
      colMaxes[colIdx] = Math.max(...vals);
    }
  }

  // Apply styling row by row
  for (const row of rows) {
    // Determine if this is a low-PA row (gray out stats)
    let isLowPa = false;
    if (paCol !== null) {
      const paVal = parseInt(row.cells[paCol]?.textContent?.trim(), 10);
      isLowPa = !isNaN(paVal) && paVal < paMin;
    }

    for (const [colIdxStr, higherIsBetter] of Object.entries(colConfig)) {
      const colIdx = Number(colIdxStr);
      const cell = row.cells[colIdx];
      if (!cell) continue;

      if (isLowPa) {
        // Gray out stat cells (col 4 onwards) for low-PA players
        for (let i = 4; i < row.cells.length; i++) {
          row.cells[i].style.opacity = '0.38';
          row.cells[i].style.backgroundColor = '';
        }
        break; // done with this row
      }

      // Apply heat-map color
      const val = parseCell(cell.textContent.trim());
      if (isNaN(val) || colMins[colIdxStr] === undefined) {
        cell.style.backgroundColor = '';
        cell.style.opacity = '';
        continue;
      }

      cell.style.opacity = '';
      cell.style.backgroundColor = getRankColor(
        val, colMins[colIdxStr], colMaxes[colIdxStr], higherIsBetter
      );
    }
  }
}

// ── Default sort ───────────────────────────────────────────────────────────

/**
 * Programmatically sort a table by a given column index and mark the header.
 */
export function sortDefault(tableId, colIndex, descending = true) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const ths = Array.from(table.querySelectorAll('th.sortable-col'));
  ths.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
  if (ths[colIndex]) ths[colIndex].classList.add(descending ? 'sort-desc' : 'sort-asc');
  sortTableByColumn(table, colIndex, descending);
}

// ── Filtering ──────────────────────────────────────────────────────────────

export function applyFilters() {
  const currentVal = document.querySelector('[data-filter="currentLevel"].active')?.dataset.value  ?? 'all';
  const highestVal = document.querySelector('[data-filter="highestLevel"].active')?.dataset.value  ?? 'all';
  const typeVal    = document.querySelector('[data-filter="type"].active')?.dataset.value           ?? 'all';
  const searchVal  = (document.getElementById('playerSearch')?.value ?? '').toLowerCase().trim();

  document.querySelectorAll('.stat-table').forEach(table => {
    if (table.id === 'tbl-transactions') return;

    table.querySelectorAll('tbody tr').forEach(row => {
      const rowCurrent = row.dataset.currentLevel ?? '';
      const rowHighest = row.dataset.highestLevel ?? '';
      const rowType    = row.dataset.type         ?? '';
      const rowName    = row.dataset.name         ?? '';

      const currentOk = currentVal === 'all' || rowCurrent === currentVal;
      const highestOk = highestVal === 'all' || rowHighest === highestVal;
      const typeOk    = typeVal    === 'all' || rowType    === typeVal;
      const searchOk  = !searchVal || rowName.includes(searchVal);

      row.hidden = !(currentOk && highestOk && typeOk && searchOk);
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
