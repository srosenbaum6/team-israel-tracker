/**
 * api.js — MLB Stats API integration
 *
 * All functions return normalized row objects ready for the table renderers.
 * The MLB Stats API (statsapi.mlb.com) is free, public, and CORS-open.
 */

const MLB_API = 'https://statsapi.mlb.com/api/v1';

// Sport levels queried in priority order (highest first).
// Each is fetched in parallel; results are merged per player.
const SPORT_LEVELS = [
  { id: 1,  abbrev: 'MLB' },
  { id: 11, abbrev: 'AAA' },
  { id: 12, abbrev: 'AA'  },
  { id: 13, abbrev: 'A+'  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(val, decimals = 3) {
  if (val == null || val === '') return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n.toFixed(decimals);
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

// ── Stat aggregation helpers ────────────────────────────────────────────────

const COUNTING_FIELDS = [
  'gamesPlayed', 'gamesStarted', 'wins', 'losses',
  'hits', 'doubles', 'triples', 'homeRuns', 'rbi',
  'baseOnBalls', 'strikeOuts', 'stolenBases',
  'plateAppearances', 'atBats', 'runs', 'earnedRuns',
  'hitByPitch', 'sacFlies',
];

function ipToOuts(ip) {
  if (ip == null) return 0;
  const f = parseFloat(ip);
  return Math.floor(f) * 3 + Math.round((f % 1) * 10);
}

function outsToIp(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

function recalcHittingRates(s) {
  const ab  = s.atBats       ?? 0;
  const h   = s.hits         ?? 0;
  const bb  = s.baseOnBalls  ?? 0;
  const hbp = s.hitByPitch   ?? 0;
  const sf  = s.sacFlies     ?? 0;
  const d   = s.doubles      ?? 0;
  const t   = s.triples      ?? 0;
  const hr  = s.homeRuns     ?? 0;
  if (ab > 0) {
    s.avg = (h / ab).toFixed(3);
    const obpN = h + bb + hbp;
    const obpD = ab + bb + hbp + sf;
    s.obp = obpD > 0 ? (obpN / obpD).toFixed(3) : null;
    const tb = h + d + 2 * t + 3 * hr;
    s.slg = (tb / ab).toFixed(3);
    s.ops = (s.obp && s.slg) ? (parseFloat(s.obp) + parseFloat(s.slg)).toFixed(3) : null;
  }
}

/**
 * Merge two stat objects from different sport levels into combined season totals.
 * statA is assumed to be from the higher-priority level (already aggregated by the API).
 */
function combinedStats(statA, statB) {
  if (!statA) return statB;
  if (!statB) return statA;

  const result = {};

  for (const key of COUNTING_FIELDS) {
    if (statA[key] != null || statB[key] != null) {
      result[key] = (statA[key] ?? 0) + (statB[key] ?? 0);
    }
  }

  // IP: convert both to outs, sum, convert back
  const totalOuts = ipToOuts(statA.inningsPitched) + ipToOuts(statB.inningsPitched);
  if (statA.inningsPitched != null || statB.inningsPitched != null) {
    result.inningsPitched = outsToIp(totalOuts);
  }

  // Recalculate rate stats from combined counting stats
  recalcHittingRates(result);

  const ipDecimal = Math.floor(totalOuts / 3) + (totalOuts % 3) / 3;
  if (ipDecimal > 0) {
    result.era  = ((result.earnedRuns ?? 0) * 9 / ipDecimal).toFixed(2);
    result.whip = (((result.baseOnBalls ?? 0) + (result.hits ?? 0)) / ipDecimal).toFixed(2);
  }

  return result;
}

// ── Fetch wrappers ─────────────────────────────────────────────────────────

async function mlbGet(path) {
  const res = await fetch(`${MLB_API}${path}`);
  if (!res.ok) throw new Error(`MLB API error ${res.status}: ${path}`);
  return res.json();
}

/**
 * Fetch season or date-range stats for a batch of player IDs across all sport levels.
 *
 * Makes parallel requests for MLB, AAA, AA, and A+ and merges the results.
 * For players who appeared at multiple levels, stats are combined and the
 * highest level is recorded.
 *
 * @returns {Promise<Object>} map of mlbId → { stat, highestLevel }
 */
async function fetchMlbStats(playerIds, group, statType, startDate, endDate, season) {
  if (!playerIds.length) return {};

  const ids = playerIds.join(',');
  const baseParams = statType === 'season'
    ? `group=${group},type=season,season=${season}`
    : `group=${group},type=byDateRange,season=${season},startDate=${startDate},endDate=${endDate}`;

  // Fetch all sport levels in parallel
  const levelResults = await Promise.all(
    SPORT_LEVELS.map(async ({ id: sportId, abbrev }) => {
      try {
        const url = `/people?personIds=${ids}&hydrate=stats(${baseParams},sportId=${sportId})`;
        const data = await mlbGet(url);
        const map = {};
        for (const person of (data.people || [])) {
          const statsArr = person.stats || [];
          const match = statsArr.find(s =>
            s.group?.displayName === group && s.splits?.length > 0
          );
          // splits[0] is the season total (cross-team aggregate for MLB, or single stint for MiLB)
          if (match) map[person.id] = match.splits[0].stat;
        }
        return { abbrev, map };
      } catch {
        return { abbrev, map: {} };
      }
    })
  );

  // Merge: process levels in priority order (highest first)
  const result = {};
  for (const { abbrev, map } of levelResults) {
    for (const [idStr, stat] of Object.entries(map)) {
      const id = Number(idStr);
      if (!result[id]) {
        result[id] = { stat, highestLevel: abbrev };
      } else {
        // Player appeared at multiple levels — aggregate all
        result[id].stat = combinedStats(result[id].stat, stat);
        // highestLevel already set from first (highest-priority) level
      }
    }
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build normalized hitting rows for a set of roster players.
 */
export async function buildHittingRows(rosterPlayers, statType, startDate, endDate, staticRows = [], season = '2026') {
  const livePlayers = rosterPlayers.filter(p => p.positionGroup === 'hitting' && p.mlbId);
  const liveIds = livePlayers.map(p => p.mlbId);

  const statsMap = await fetchMlbStats(liveIds, 'hitting', statType, startDate, endDate, season);

  const rows = livePlayers.map(p => {
    const entry = statsMap[p.mlbId];
    const s  = entry?.stat ?? null;
    const pa = s?.plateAppearances ?? null;
    const bb = s?.baseOnBalls ?? null;
    const so = s?.strikeOuts ?? null;
    return {
      mlbId:        p.mlbId,
      name:         p.name,
      bbrefId:      p.bbrefId      ?? null,
      bbrefRegId:   p.bbrefRegId   ?? null,
      team:         p.team,
      orgLevel:     p.level,
      highestLevel: entry?.highestLevel ?? null,
      positionGroup: 'hitting',
      G:       s?.gamesPlayed     ?? null,
      PA:      pa,
      AB:      s?.atBats          ?? null,
      H:       s?.hits            ?? null,
      doubles: s?.doubles         ?? null,
      triples: s?.triples         ?? null,
      HR:      s?.homeRuns        ?? null,
      RBI:     s?.rbi             ?? null,
      BB:      bb,
      SO:      so,
      SB:      s?.stolenBases     ?? null,
      AVG:     s?.avg  != null ? parseFloat(s.avg)  : null,
      OBP:     s?.obp  != null ? parseFloat(s.obp)  : null,
      SLG:     s?.slg  != null ? parseFloat(s.slg)  : null,
      OPS:     s?.ops  != null ? parseFloat(s.ops)  : null,
      SOPct:   (pa && so != null && pa > 0) ? so / pa : null,
      BBPct:   (pa && bb != null && pa > 0) ? bb / pa : null,
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
    const entry = statsMap[p.mlbId];
    const s   = entry?.stat ?? null;
    const ip  = s?.inningsPitched != null ? parseFloat(s.inningsPitched) : null;
    const so  = s?.strikeOuts  ?? null;
    const bb  = s?.baseOnBalls ?? null;
    const k9  = (ip && so != null && ip > 0) ? (so * 9 / ip) : null;
    const bb9 = (ip && bb != null && ip > 0) ? (bb * 9 / ip) : null;
    return {
      mlbId:        p.mlbId,
      name:         p.name,
      bbrefId:      p.bbrefId    ?? null,
      bbrefRegId:   p.bbrefRegId ?? null,
      team:         p.team,
      orgLevel:     p.level,
      highestLevel: entry?.highestLevel ?? null,
      positionGroup: 'pitching',
      G:    s?.gamesPlayed  ?? null,
      GS:   s?.gamesStarted ?? null,
      IP:   ip,
      W:    s?.wins         ?? null,
      L:    s?.losses       ?? null,
      H:    s?.hits         ?? null,
      ER:   s?.earnedRuns   ?? null,
      BB:   bb,
      SO:   so,
      ERA:  s?.era  != null ? parseFloat(s.era)  : null,
      WHIP: s?.whip != null ? parseFloat(s.whip) : null,
      K9:   k9,
      BB9:  bb9,
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
        toTeam:      t.toTeam?.name   ?? '—',
        description: t.description || '',
      });
    }
  }

  txns.sort((a, b) => b.date.localeCompare(a.date));
  return txns;
}
