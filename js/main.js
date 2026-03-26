/**
 * main.js — App entry point (ES module)
 *
 * Loaded as <script type="module"> — imports api.js and tables.js directly.
 * Requires a local server (e.g. VS Code Live Server) to avoid CORS restrictions.
 */

import {
  buildHittingRows, buildPitchingRows, fetchTransactions, buildFieldingData,
  fetchPlayerStatuses, dateNDaysAgo, today,
} from './api.js';

import {
  hittingRowHtml, pitchingRowHtml, transactionRowHtml,
  populateTable, initSort, initFilters, applyFilters, applyTxnSearch,
  colorizeTable, sortDefault, playerLink, handColorStyle,
} from './tables.js';

import { loadReportsTab } from './reports.js';

// Last day of each completed season — used to anchor "Last 30/10 days" tabs
// so they show the final stretch of that season rather than days from today.
const SEASON_END = {
  '2025': '2025-09-28',
  '2026': null,   // null = use today (season in progress)
};

// ── Color-coding config ────────────────────────────────────────────────────
// Maps column index → true (higher is better / red) | false (lower is better / blue)
// Hitting table columns: [0]Player [1]Org [2]CurLvl [3]HiLvl [4]G [5]PA
//   [6]AVG [7]OBP [8]SLG [9]OPS [10]SO% [11]BB% [12]2B [13]3B [14]HR [15]RBI [16]SB [17]CS
const HITTING_COLOR = {
  6: true,   // AVG
  7: true,   // OBP
  8: true,   // SLG
  9: true,   // OPS
  10: false, // SO% (high SO% is bad for hitters)
  11: true,  // BB%
  12: true,  // 2B
  13: true,  // 3B
  14: true,  // HR
  15: true,  // RBI
  16: true,  // SB
};

// Pitching table columns: [0]Player [1]Org [2]CurLvl [3]HiLvl [4]G [5]GS [6]IP
//   [7]SO% [8]BB% [9]SO-BB% [10]WHIP [11]ERA
const PITCHING_COLOR = {
  7: true,   // SO%
  8: false,  // BB% (high BB% is bad)
  9: true,   // SO-BB%
  10: false, // WHIP
  11: false, // ERA
};

(async function () {

  // ── State ──────────────────────────────────────────────────────────────
  let roster = [];          // full roster array from roster.json
  let rosterMap = {};       // mlbId → player object
  let indyStats = null;     // loaded once from indy_stats.json
  let otherStats = null;    // loaded once from other_stats.json

  let selectedSeason = '2026';

  // Track which tabs have already been loaded to avoid redundant API calls
  // Reset whenever the season changes
  let loaded = { season: false, last30: false, last10: false, transactions: false, defense: false, reports: false };

  // Returns the "anchor" end-date for date-range tabs.
  // For past seasons, use the known season-end date; for current, use today.
  function seasonEndDate() {
    return SEASON_END[selectedSeason] ?? today();
  }

  // Cached status data — fetched once in the background after roster loads
  let cachedStatuses = null; // { liveSet, ilSet }

  // Apply live/IL icons to every tr[data-mlbid] currently in the DOM.
  // Called once when statuses arrive, and again after each tab populates.
  function applyStatusIcons({ liveSet, ilSet }) {
    document.querySelectorAll('tr[data-mlbid]:not([data-status-applied])').forEach(row => {
      row.dataset.statusApplied = '1';
      const id = parseInt(row.dataset.mlbid, 10);
      if (!id) return;
      const cell = row.querySelector('.player-name-cell');
      if (!cell) return;
      if (liveSet.has(id)) {
        cell.insertAdjacentHTML('beforeend',
          '<span class="status-live" title="Currently in a live game"></span>');
      }
      if (ilSet.has(id)) {
        cell.insertAdjacentHTML('beforeend',
          '<span class="status-il" title="On the Injured List">IL</span>');
      }
    });
  }

  // ── UI helpers ──────────────────────────────────────────────────────────

  function showLoading(show) {
    document.getElementById('loadingMsg').hidden = !show;
  }

  function showError(msg) {
    const el = document.getElementById('errorMsg');
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ── Load static data ────────────────────────────────────────────────────

  async function loadRoster() {
    const res = await fetch('./data/roster.json');
    const data = await res.json();
    roster = data.players;
    rosterMap = Object.fromEntries(
      roster.filter(p => p.mlbId).map(p => [p.mlbId, p])
    );
  }

  async function loadIndyStats() {
    if (indyStats) return;
    try {
      const res = await fetch('./data/indy_stats.json');
      indyStats = await res.json();
    } catch {
      indyStats = { hitting: [], pitching: [] };
    }
  }

  async function loadOtherStats() {
    if (otherStats) return;
    try {
      const res = await fetch('./data/other_stats.json');
      otherStats = await res.json();
    } catch {
      otherStats = { hitting: [], pitching: [], transactions: [] };
    }
  }

  // ── Convert indy/other JSON entries → normalized row objects ─────────────

  function buildStaticHittingRows(source) {
    return (source?.hitting ?? []).map(p => {
      const pa = p.stats?.PA ?? null;
      const bb = p.stats?.BB ?? null;
      const so = p.stats?.SO ?? null;
      return {
        mlbId:             p.playerId   ?? null,
        name:              p.playerName,
        bbrefId:           p.bbrefId    ?? null,
        bbrefRegId:        p.bbrefRegId ?? null,
        team:              p.team,
        currentLevel:      p.level,
        careerHighestLevel: p.level,
        positionGroup:     'hitting',
        G:       p.stats?.G       ?? null,
        PA:      pa,
        AB:      p.stats?.AB      ?? null,
        doubles: p.stats?.doubles ?? null,
        triples: p.stats?.triples ?? null,
        HR:      p.stats?.HR      ?? null,
        RBI:     p.stats?.RBI     ?? null,
        BB:      bb,
        SO:      so,
        SB:      p.stats?.SB      ?? null,
        CS:      p.stats?.CS      ?? null,
        AVG:     p.stats?.AVG     ?? null,
        OBP:     p.stats?.OBP     ?? null,
        SLG:     p.stats?.SLG     ?? null,
        OPS:     p.stats?.OPS     ?? null,
        SOPct:   (pa && so != null && pa > 0) ? so / pa : null,
        BBPct:   (pa && bb != null && pa > 0) ? bb / pa : null,
      };
    });
  }

  function buildStaticPitchingRows(source) {
    return (source?.pitching ?? []).map(p => ({
      mlbId:             p.playerId   ?? null,
      name:              p.playerName,
      bbrefId:           p.bbrefId    ?? null,
      bbrefRegId:        p.bbrefRegId ?? null,
      team:              p.team,
      currentLevel:      p.level,
      careerHighestLevel: p.level,
      positionGroup:     'pitching',
      G:        p.stats?.G    ?? null,
      GS:       p.stats?.GS   ?? null,
      IP:       p.stats?.IP   ?? null,
      ERA:      p.stats?.ERA  ?? null,
      WHIP:     p.stats?.WHIP ?? null,
      SOPct:    null,
      BBPct:    null,
      SOBBPct:  null,
    }));
  }

  // ── Tab loaders ─────────────────────────────────────────────────────────

  async function loadSeasonTab() {
    if (loaded.season) return;
    showLoading(true);
    showError('');
    try {
      await Promise.all([loadIndyStats(), loadOtherStats()]);

      const staticHitting = [
        ...buildStaticHittingRows(indyStats),
        ...buildStaticHittingRows(otherStats),
      ];
      const staticPitching = [
        ...buildStaticPitchingRows(indyStats),
        ...buildStaticPitchingRows(otherStats),
      ];

      const [hittingRows, pitchingRows] = await Promise.all([
        buildHittingRows(roster,  'season', null, null, staticHitting,  selectedSeason),
        buildPitchingRows(roster, 'season', null, null, staticPitching, selectedSeason),
      ]);

      populateTable('tbl-season-hitting',  hittingRows.map(hittingRowHtml),  'No hitting stats available.');
      populateTable('tbl-season-pitching', pitchingRows.map(pitchingRowHtml), 'No pitching stats available.');

      // Update section headings to reflect the selected season
      const yr = selectedSeason;
      const hitH2 = document.querySelector('#section-season-hitting h2');
      const pitH2 = document.querySelector('#section-season-pitching h2');
      if (hitH2) hitH2.textContent = `Hitters \u2014 ${yr}`;
      if (pitH2) pitH2.textContent = `Pitchers \u2014 ${yr}`;

      ['tbl-season-hitting', 'tbl-season-pitching'].forEach(initSort);
      // Color-code stats, gray low-PA hitters, then apply default sort
      colorizeTable('tbl-season-hitting',  HITTING_COLOR,  5, 50);
      colorizeTable('tbl-season-pitching', PITCHING_COLOR, 6, 10);
      sortDefault('tbl-season-hitting',  9, true);   // OPS desc
      sortDefault('tbl-season-pitching', 9, true);   // SO-BB% desc
      applyFilters();
      if (cachedStatuses) applyStatusIcons(cachedStatuses);
      loaded.season = true;
    } catch (err) {
      showError(`Failed to load season stats: ${err.message}`);
      console.error(err);
    } finally {
      showLoading(false);
    }
  }

  async function loadDateRangeTab(days, tabKey) {
    if (loaded[tabKey]) return;
    showLoading(true);
    showError('');
    try {
      await Promise.all([loadIndyStats(), loadOtherStats()]);

      // For past seasons, anchor the end date to the known season end
      // rather than today so we always get the final N days of that season.
      const endDate   = seasonEndDate();
      const startDate = dateNDaysAgo(days, endDate);

      // Show date range note
      const note = document.getElementById(`note-${tabKey}`);
      if (note) note.textContent = `Stats from ${startDate} through ${endDate}`;

      // Indy/other stats don't have date-range splits — include season totals with a note
      const staticHitting  = buildStaticHittingRows(indyStats).concat(buildStaticHittingRows(otherStats));
      const staticPitching = buildStaticPitchingRows(indyStats).concat(buildStaticPitchingRows(otherStats));

      const [hittingRows, pitchingRows] = await Promise.all([
        buildHittingRows(roster,  'byDateRange', startDate, endDate, staticHitting,  selectedSeason),
        buildPitchingRows(roster, 'byDateRange', startDate, endDate, staticPitching, selectedSeason),
      ]);

      populateTable(`tbl-${tabKey}-hitting`,  hittingRows.map(hittingRowHtml),  'No hitting stats in this window.');
      populateTable(`tbl-${tabKey}-pitching`, pitchingRows.map(pitchingRowHtml), 'No pitching stats in this window.');

      [`tbl-${tabKey}-hitting`, `tbl-${tabKey}-pitching`].forEach(initSort);
      colorizeTable(`tbl-${tabKey}-hitting`,  HITTING_COLOR,  5, 50);
      colorizeTable(`tbl-${tabKey}-pitching`, PITCHING_COLOR, 6, 10);
      sortDefault(`tbl-${tabKey}-hitting`,  9, true);
      sortDefault(`tbl-${tabKey}-pitching`, 9, true);
      applyFilters();
      if (cachedStatuses) applyStatusIcons(cachedStatuses);
      loaded[tabKey] = true;
    } catch (err) {
      showError(`Failed to load stats: ${err.message}`);
      console.error(err);
    } finally {
      showLoading(false);
    }
  }

  async function loadTransactionsTab(startDate, endDate) {
    showLoading(true);
    showError('');
    try {
      await loadOtherStats();

      const mlbIds = roster.filter(p => p.mlbId).map(p => p.mlbId);
      const txns = await fetchTransactions(mlbIds, startDate, endDate);

      // Append any manual transactions from other_stats.json
      const manualTxns = (otherStats?.transactions ?? []).map(t => ({
        id:          `manual-${t.date}-${t.player}`,
        date:        t.date,
        player:      t.player,
        mlbId:       null,
        type:        t.type,
        fromTeam:    t.fromTeam ?? '—',
        toTeam:      t.toTeam   ?? '—',
        description: t.description ?? '',
      }));

      const rosterMlbIdSet = new Set(mlbIds);
      const allTxns = [...txns, ...manualTxns]
        .filter(t => !t.mlbId || rosterMlbIdSet.has(t.mlbId))
        .filter(t => t.player && t.player.trim() !== '')
        .sort((a, b) => b.date.localeCompare(a.date));

      populateTable(
        'tbl-transactions',
        allTxns.map(t => transactionRowHtml(t, rosterMap)),
        'No transactions found for this date range.'
      );

      initSort('tbl-transactions');
      const txnSearch = document.getElementById('txnSearch');
      if (txnSearch?.value) applyTxnSearch(txnSearch.value);
    } catch (err) {
      showError(`Failed to load transactions: ${err.message}`);
      console.error(err);
    } finally {
      showLoading(false);
    }
  }

  async function loadDefenseTab() {
    if (loaded.defense) return;
    showLoading(true);
    showError('');
    try {
      const fieldingData = await buildFieldingData(roster, selectedSeason);

      const note = document.getElementById('note-defense');
      if (note) note.innerHTML =
        `${selectedSeason} Season &mdash; <em>Affiliated games only (MLB &amp; MiLB). Independent/Indy league games are not reflected here.</em>`;

      // ── Field diagram ────────────────────────────────────────────────
      const FIELD_POSITIONS = ['LF', 'CF', 'RF', '3B', 'SS', '2B', '1B', 'C', 'DH'];
      for (const pos of FIELD_POSITIONS) {
        const container = document.getElementById(`players-${pos}`);
        if (!container) continue;

        const players = fieldingData[pos] ?? [];
        if (!players.length) {
          container.innerHTML = '<span class="pos-empty">—</span>';
        } else {
          container.innerHTML = players.map((p, i) =>
            `<div class="pos-player${i === 0 ? ' pos-starter' : ''}">
              <span class="pos-player-name" style="${handColorStyle(p.bats)}">${p.name}</span>
              <span class="pos-player-g">${p.G}G</span>
            </div>`
          ).join('');
        }
      }

      // ── Position table ───────────────────────────────────────────────
      const TABLE_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];

      // Gather all players who appeared at any table position
      const allPlayers = new Map(); // mlbId → { name, mlbId, bbrefId, bbrefRegId, posG:{} }
      for (const pos of TABLE_POSITIONS) {
        for (const p of (fieldingData[pos] ?? [])) {
          if (!allPlayers.has(p.mlbId)) {
            allPlayers.set(p.mlbId, {
              name:      p.name,
              mlbId:     p.mlbId,
              bbrefId:   p.bbrefId,
              bbrefRegId: p.bbrefRegId,
              bats:      p.bats ?? null,
              posG:      {},
            });
          }
          allPlayers.get(p.mlbId).posG[pos] = p.G;
        }
      }

      // Sort by total games across all positions
      const playerRows = Array.from(allPlayers.values()).sort((a, b) => {
        const aTotal = Object.values(a.posG).reduce((s, g) => s + g, 0);
        const bTotal = Object.values(b.posG).reduce((s, g) => s + g, 0);
        return bTotal - aTotal;
      });

      const htmlRows = playerRows.map(p => {
        const cells = TABLE_POSITIONS.map(pos => {
          const g = p.posG[pos];
          return `<td class="num-col">${g != null ? g : '—'}</td>`;
        }).join('');
        return `<tr data-mlbid="${p.mlbId ?? ''}" data-name="${p.name.toLowerCase()}">
          <td class="player-name-cell" style="${handColorStyle(p.bats)}">${playerLink(p.name, p.bbrefId, p.bbrefRegId, p.mlbId)}</td>
          ${cells}
        </tr>`;
      });

      populateTable('tbl-defense', htmlRows, 'No fielding data available.');
      initSort('tbl-defense');
      if (cachedStatuses) applyStatusIcons(cachedStatuses);
      loaded.defense = true;
    } catch (err) {
      showError(`Failed to load fielding stats: ${err.message}`);
      console.error(err);
    } finally {
      showLoading(false);
    }
  }

  // ── Season selector ──────────────────────────────────────────────────────

  function initSeasonSelector() {
    document.querySelectorAll('.season-btn').forEach(btn => {
      if (btn.dataset.season === selectedSeason) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (btn.dataset.season === selectedSeason) return; // no-op
        selectedSeason = btn.dataset.season;

        // Update button highlight
        document.querySelectorAll('.season-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.season === selectedSeason)
        );

        // Reset all loaded flags so tabs re-fetch for the new season
        // Note: reports are season-independent, so we keep loaded.reports as-is
        loaded = { season: false, last30: false, last10: false, transactions: false, defense: false, reports: loaded.reports };

        // Update transactions default date range to match season
        const startInput = document.getElementById('txnStartDate');
        const endInput   = document.getElementById('txnEndDate');
        if (selectedSeason === '2025') {
          if (startInput) startInput.value = '2025-03-20';
          if (endInput)   endInput.value   = '2025-10-30';
        } else {
          if (startInput) startInput.value = dateNDaysAgo(90);
          if (endInput)   endInput.value   = today();
        }

        // Reload the currently active tab
        const activeTab = document.querySelector('.tab.active')?.dataset.tab ?? 'season';
        switchTab(activeTab);

        // If Defense type is currently selected, reload defense data for the new season
        const defenseTypeActive = document.querySelector('[data-filter="type"][data-value="defense"]')
          ?.classList.contains('active');
        if (defenseTypeActive) loadDefenseTab();
      });
    });
  }

  // ── Tab switching ────────────────────────────────────────────────────────

  function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Show/hide panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.hidden = panel.id !== `panel-${tabName}`;
    });

    // Show/hide shared filter bar (not shown on transactions or reports tabs)
    document.getElementById('statsFilterBar').hidden = (tabName === 'transactions' || tabName === 'reports');

    // Load data for the tab
    switch (tabName) {
      case 'season':       loadSeasonTab(); break;
      case 'last30':       loadDateRangeTab(30, 'last30'); break;
      case 'last10':       loadDateRangeTab(10, 'last10'); break;
      case 'transactions': /* loaded on button click */ break;
      case 'reports':
        if (!loaded.reports) { loaded.reports = true; loadReportsTab(); }
        break;
    }
  }

  // ── Transactions fetch button ────────────────────────────────────────────

  function initTransactionControls() {
    // Default date range: full 2025 season (matches default selectedSeason)
    const startInput = document.getElementById('txnStartDate');
    const endInput   = document.getElementById('txnEndDate');
    if (startInput) startInput.value = '2025-03-20';
    if (endInput)   endInput.value   = '2025-10-30';

    document.getElementById('txnFetchBtn')?.addEventListener('click', () => {
      const start = startInput?.value || dateNDaysAgo(90);
      const end   = endInput?.value   || today();
      loadTransactionsTab(start, end);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  try {
    await loadRoster();
  } catch (err) {
    showError('Could not load roster data. Make sure roster.json exists.');
    console.error(err);
    return;
  }

  // Kick off status fetch in the background — doesn't block page load.
  // When resolved, apply icons to whatever rows are already in the DOM.
  fetchPlayerStatuses(roster)
    .then(statuses => {
      cachedStatuses = statuses;
      applyStatusIcons(cachedStatuses);
    })
    .catch(() => {});

  initFilters();

  // Load defense data when the Defense type filter is clicked
  document.querySelectorAll('[data-filter="type"]').forEach(btn => {
    if (btn.dataset.value === 'defense') {
      btn.addEventListener('click', () => loadDefenseTab());
    }
  });

  initSeasonSelector();
  initTransactionControls();

  // Wire up tab clicks
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Load the default tab (Season)
  switchTab('season');

})();
