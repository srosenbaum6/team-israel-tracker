/**
 * api.js — MLB Stats API integration
 *
 * All functions return normalized row objects ready for the table renderers.
 * The MLB Stats API (statsapi.mlb.com) is free, public, and CORS-open.
 */

const MLB_API = 'https://statsapi.mlb.com/api/v1';

// The last day of the 2025 MLB regular season — used to anchor date-range
// tabs when the 2025 season is selected.
export const SEASON_END = {
  '2025': '2025-09-28',
  '2026': null,   // null = use today's date (season in progress)
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(val, decimals = 3) {
  if (val == null || val === '') return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n.toFixed(decimals);
}

function fmtAvg(val)  { return fmt(val, 3); }
function fmtRate(val) { return fmt(val, 2); }
function fmtInt(val)  { return val != null ? String(val) : '—'; }
function fmtIP(val)   {
  if (val == null) return '—';
  // MLB API returns IP as a decimal (e.g. 7.2 = 7⅔ innings) — display as-is
  return parseFloat(val).toFixed(1);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// anchorDate is optional YYYY-MM-DD string; defaults to today
export function dateNDaysAgo(n, anchorDate) {
  const d = anchorDate ? new Date(anchorDate + 'T12:00:00') : new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

export function today() {
  return isoDate(new Date());
}

// ── Fetch wrappers ─────────────────────────────────────────────────────────

async function mlbGet(path) {
  const res = await fetch(`${MLB_API}${path}`);
  if (!res.ok) throw new Error(`MLB API error ${res.status}: ${path}`);
  return res.json();
}

/**
 * Fetch stats for a batch of MLB player IDs using the hydrate endpoint.
 * @param {number[]} playerIds
 * @param {'hitting'|'pitching'} group
 * @param {'season'|'byDateRange'} statType
 * @param {string} [startDate]  YYYY-MM-DD  (required for byDateRange)
 * @param {string} [endDate]    YYYY-MM-DD  (required for byDateRange)
 * @returns {Promise<Object>} map of mlbId → stat object (or null)
 */
async function fetchMlbStats(playerIds, group, statType, startDate, endDate, season) {
  if (!playerIds.length) return {};

  const ids = playerIds.join(',');
  let hydrateParam;

  if (statType === 'season') {
    hydrateParam = `stats(group=${group},type=season,season=${season})`;
  } else {
    hydrateParam = `stats(group=${group},type=byDateRange,season=${season},startDate=${startDate},endDate=${endDate})`;
  }

  const url = `/people?personIds=${ids}&hydrate=${hydrateParam}`;
  const data = await mlbGet(url);

  const result = {};
  for (const person of (data.people || [])) {
    const statsArr = person.stats || [];
    const match = statsArr.find(s =>
      s.group?.displayName === group &&
      s.splits?.length > 0
    );
    result[person.id] = match?.splits?.[0]?.stat ?? null;
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build normalized hitting rows for a set of roster players.
 * Returns rows for MLB/MiLB players (with live stats) + any static rows passed in.
 *
 * @param {Object[]} rosterPlayers  - filtered subset of roster.json
 * @param {'season'|'byDateRange'} statType
 * @param {string} [startDate]
 * @param {string} [endDate]
 * @param {Object[]} [staticRows]   - pre-built rows from indy/other JSON files
 * @returns {Promise<Object[]>}
 */
export async function buildHittingRows(rosterPlayers, statType, startDate, endDate, staticRows = [], season = '2026') {
  const livePlayers = rosterPlayers.filter(p => p.positionGroup === 'hitting' && p.mlbId);
  const liveIds = livePlayers.map(p => p.mlbId);

  const statsMap = await fetchMlbStats(liveIds, 'hitting', statType, startDate, endDate, season);

  const rows = livePlayers.map(p => {
    const s = statsMap[p.mlbId];
    return {
      mlbId:    p.mlbId,
      name:     p.name,
      bbrefId:  p.bbrefId,
      team:     p.team,
      level:    p.level,
      positionGroup: 'hitting',
      // raw values for sorting
      G:        s?.gamesPlayed ?? null,
      PA:       s?.plateAppearances ?? null,
      AB:       s?.atBats ?? null,
      H:        s?.hits ?? null,
      doubles:  s?.doubles ?? null,
      triples:  s?.triples ?? null,
      HR:       s?.homeRuns ?? null,
      RBI:      s?.rbi ?? null,
      BB:       s?.baseOnBalls ?? null,
      SO:       s?.strikeOuts ?? null,
      SB:       s?.stolenBases ?? null,
      AVG:      s?.avg != null ? parseFloat(s.avg) : null,
      OBP:      s?.obp != null ? parseFloat(s.obp) : null,
      SLG:      s?.slg != null ? parseFloat(s.slg) : null,
      OPS:      s?.ops != null ? parseFloat(s.ops) : null,
    };
  });

  return [...rows, ...staticRows];
}

/**
 * Build normalized pitching rows.
 */
export async function buildPitchingRows(rosterPlayers, statType, startDate, endDate, staticRows = [], season = '2026') {
  const livePlayers = rosterPlayers.filter(p => p.positionGroup === 'pitching' && p.mlbId);
  const liveIds = livePlayers.map(p => p.mlbId);

  const statsMap = await fetchMlbStats(liveIds, 'pitching', statType, startDate, endDate, season);

  const rows = livePlayers.map(p => {
    const s = statsMap[p.mlbId];
    const ip  = s?.inningsPitched != null ? parseFloat(s.inningsPitched) : null;
    const so  = s?.strikeOuts ?? null;
    const bb  = s?.baseOnBalls ?? null;
    const k9  = (ip && so != null && ip > 0) ? (so * 9 / ip) : null;
    const bb9 = (ip && bb != null && ip > 0) ? (bb * 9 / ip) : null;

    return {
      mlbId:    p.mlbId,
      name:     p.name,
      bbrefId:  p.bbrefId,
      team:     p.team,
      level:    p.level,
      positionGroup: 'pitching',
      G:        s?.gamesPitched ?? null,
      GS:       s?.gamesStarted ?? null,
      IP:       ip,
      W:        s?.wins ?? null,
      L:        s?.losses ?? null,
      H:        s?.hits ?? null,
      ER:       s?.earnedRuns ?? null,
      BB:       bb,
      SO:       so,
      ERA:      s?.era != null ? parseFloat(s.era) : null,
      WHIP:     s?.whip != null ? parseFloat(s.whip) : null,
      K9:       k9,
      BB9:      bb9,
    };
  });

  return [...rows, ...staticRows];
}

/**
 * Fetch transactions for all roster players with MLB IDs.
 * @param {number[]} mlbIds
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {Promise<Object[]>} sorted by date desc
 */
export async function fetchTransactions(mlbIds, startDate, endDate) {
  if (!mlbIds.length) return [];

  const ids = mlbIds.join(',');
  // sportId=1 = MLB; sportId=11 = MiLB (all levels)
  // We fetch both so MiLB call-ups/optionings appear
  const [mlbData, milbData] = await Promise.allSettled([
    mlbGet(`/transactions?playerIds=${ids}&startDate=${startDate}&endDate=${endDate}&sportId=1`),
    mlbGet(`/transactions?playerIds=${ids}&startDate=${startDate}&endDate=${endDate}&sportId=11`),
  ]);

  const seen = new Set();
  const txns = [];

  for (const settled of [mlbData, milbData]) {
    if (settled.status !== 'fulfilled') continue;
    for (const t of (settled.value?.transactions || [])) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      txns.push({
        id:          t.id,
        date:        t.date || t.effectiveDate || '',
        player:      t.person?.fullName ?? '—',
        mlbId:       t.person?.id ?? null,
        type:        t.typeDesc || t.transactionType || '—',
        fromTeam:    t.fromTeam?.name ?? '—',
        toTeam:      t.toTeam?.name ?? '—',
        description: t.description || '',
      });
    }
  }

  // Sort newest first
  txns.sort((a, b) => b.date.localeCompare(a.date));
  return txns;
}
