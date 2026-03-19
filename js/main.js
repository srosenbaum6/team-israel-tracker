/**
 * main.js — App entry point (ES module)
 *
 * Loaded as <script type="module"> — imports api.js and tables.js directly.
 * Requires a local server (e.g. VS Code Live Server) to avoid CORS restrictions.
 */

import {
  buildHittingRows, buildPitchingRows, fetchTransactions, dateNDaysAgo, today,
} from './api.js';

import {
  hittingRowHtml, pitchingRowHtml, transactionRowHtml,
  populateTable, initSort, initFilters, applyFilters, applyTxnSearch,
} from './tables.js';

// Last day of each completed season — used to anchor "Last 30/10 days" tabs
// so they show the final stretch of that season rather than days from today.
const SEASON_END = {
  '2025': '2025-09-28',
  '2026': null,   // null = use today (season in progress)
};

(async function () {

  // ── State ──────────────────────────────────────────────────────────────
  let roster = [];          // full roster array from roster.json
  let rosterMap = {};       // mlbId → player object
  let indyStats = null;     // loaded once from indy_stats.json
  let otherStats = null;    // loaded once from other_stats.json

  // Default to 2025 since the 2026 season has not yet started
  let selectedSeason = '2025';

  // Track which tabs have already been loaded to avoid redundant API calls
  // Reset whenever the season changes
  let loaded = { season: false, last30: false, last10: false, transactions: false };

  // Returns the "anchor" end-date for date-range tabs.
  // For past seasons, use the known season-end date; for current, use today.
  function seasonEndDate() {
    return SEASON_END[selectedSeason] ?? today();
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
    return (source?.hitting ?? []).map(p => ({
      mlbId:    p.playerId ?? null,
      name:     p.playerName,
      bbrefId:  p.bbrefId ?? null,
      team:     p.team,
      level:    p.level,
      positionGroup: 'hitting',
      G:        p.stats?.G       ?? null,
      PA:       p.stats?.PA      ?? null,
      AB:       p.stats?.AB      ?? null,
      H:        p.stats?.H       ?? null,
      doubles:  p.stats?.doubles ?? null,
      triples:  p.stats?.triples ?? null,
      HR:       p.stats?.HR      ?? null,
      RBI:      p.stats?.RBI     ?? null,
      BB:       p.stats?.BB      ?? null,
      SO:       p.stats?.SO      ?? null,
      SB:       p.stats?.SB      ?? null,
      AVG:      p.stats?.AVG     ?? null,
      OBP:      p.stats?.OBP     ?? null,
      SLG:      p.stats?.SLG     ?? null,
      OPS:      p.stats?.OPS     ?? null,
    }));
  }

  function buildStaticPitchingRows(source) {
    return (source?.pitching ?? []).map(p => ({
      mlbId:    p.playerId ?? null,
      name:     p.playerName,
      bbrefId:  p.bbrefId ?? null,
      team:     p.team,
      level:    p.level,
      positionGroup: 'pitching',
      G:        p.stats?.G    ?? null,
      GS:       p.stats?.GS   ?? null,
      IP:       p.stats?.IP   ?? null,
      W:        p.stats?.W    ?? null,
      L:        p.stats?.L    ?? null,
      H:        p.stats?.H    ?? null,
      ER:       p.stats?.ER   ?? null,
      BB:       p.stats?.BB   ?? null,
      SO:       p.stats?.SO   ?? null,
      ERA:      p.stats?.ERA  ?? null,
      WHIP:     p.stats?.WHIP ?? null,
      K9:       p.stats?.K9   ?? null,
      BB9:      p.stats?.BB9  ?? null,
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

      ['tbl-season-hitting', 'tbl-season-pitching'].forEach(initSort);
      applyFilters();
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
      applyFilters();
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

      const allTxns = [...txns, ...manualTxns]
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
        loaded = { season: false, last30: false, last10: false, transactions: false };

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

    // Show/hide shared filter bar (not shown on transactions tab)
    document.getElementById('statsFilterBar').hidden = (tabName === 'transactions');

    // Load data for the tab
    switch (tabName) {
      case 'season':       loadSeasonTab(); break;
      case 'last30':       loadDateRangeTab(30, 'last30'); break;
      case 'last10':       loadDateRangeTab(10, 'last10'); break;
      case 'transactions': /* loaded on button click */ break;
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

  initFilters();
  initSeasonSelector();
  initTransactionControls();

  // Wire up tab clicks
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Load the default tab (Season)
  switchTab('season');

})();
