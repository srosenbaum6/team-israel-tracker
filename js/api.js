/**
 * api.js — MLB Stats API integration
 *
 * All functions return normalized row objects ready for the table renderers.
 * The MLB Stats API (statsapi.mlb.com) is free, public, and CORS-open.
 */

const MLB_API = 'https://statsapi.mlb.com/api/v1';

// Sport levels queried in priority order (highest first).
const SPORT_LEVELS = [
  { id: 1,  abbrev: 'MLB' },
  { id: 11, abbrev: 'AAA' },
  { id: 12, abbrev: 'AA'  },
  { id: 13, abbrev: 'A+'  },
  { id: 14, abbrev: 'A'   },
  { id: 16, abbrev: 'Rk'  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

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
  'baseOnBalls', 'strikeOuts', 'stolenBases', 'caughtStealing',
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

function combinedStats(statA, statB) {
  if (!statA) return statB;
  if (!statB) return statA;

  const result = {};
  for (const key of COUNTING_FIELDS) {
    if (statA[key] != null || statB[key] != null) {
      result[key] = (statA[key] ?? 0) + (statB[key] ?? 0);
    }
  }

  const totalOuts = ipToOuts(statA.inningsPitched) + ipToOuts(statB.inningsPitched);
  if (statA.inningsPitched != null || statB.inningsPitched != null) {
    result.inningsPitched = outsToIp(totalOuts);
  }

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
 * Fetch season/date-range stats across MLB, AAA, AA, A+ in parallel.
 * Returns { [mlbId]: { stat, highestLevel } }
 */
async function fetchMlbStats(playerIds, group, statType, startDate, endDate, season) {
  if (!playerIds.length) return {};

  const ids = playerIds.join(',');
  const baseParams = statType === 'season'
    ? `group=${group},type=season,season=${season}`
    : `group=${group},type=byDateRange,season=${season},startDate=${startDate},endDate=${endDate}`;

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
          if (match) map[person.id] = match.splits[0].stat;
        }
        return { abbrev, map };
      } catch {
        return { abbrev, map: {} };
      }
    })
  );

  const result = {};
  for (const { abbrev, map } of levelResults) {
    for (const [idStr, stat] of Object.entries(map)) {
      const id = Number(idStr);
      if (!result[id]) {
        result[id] = { stat, highestLevel: abbrev };
      } else {
        result[id].stat = combinedStats(result[id].stat, stat);
      }
    }
  }
  return result;
}

/**
 * Check which players have ever appeared in an MLB game (career stats at sportId=1).
 * Returns a Set of mlbIds.
 */
async function fetchCareerMlbPlayers(playerIds, group) {
  if (!playerIds.length) return new Set();
  const ids = playerIds.join(',');
  try {
    const url = `/people?personIds=${ids}&hydrate=stats(group=${group},type=career,sportId=1)`;
    const data = await mlbGet(url);
    const mlbSet = new Set();
    for (const person of (data.people || [])) {
      const match = (person.stats || []).find(s =>
        s.group?.displayName === group && s.splits?.length > 0
      );
      if (match) mlbSet.add(person.id);
    }
    return mlbSet;
  } catch {
    return new Set();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function buildHittingRows(rosterPlayers, statType, startDate, endDate, staticRows = [], season = '2026') {
  const livePlayers = rosterPlayers.filter(p => p.positionGroup === 'hitting' && p.mlbId);
  const liveIds = livePlayers.map(p => p.mlbId);

  const [statsMap, careerMlbSet] = await Promise.all([
    fetchMlbStats(liveIds, 'hitting', statType, startDate, endDate, season),
    fetchCareerMlbPlayers(liveIds, 'hitting'),
  ]);

  const rows = livePlayers.map(p => {
    const entry        = statsMap[p.mlbId];
    const s            = entry?.stat ?? null;
    const hasPlayedMlb = careerMlbSet.has(p.mlbId);
    // Indy/FA players' primary affiliation is independent — don't let a
    // brief affiliated stint override their roster classification.
    const NON_AFFILIATED = new Set(['Indy', 'FA']);
    const currentLevel = NON_AFFILIATED.has(p.level)
      ? p.level
      : (entry?.highestLevel ?? p.level);
    const careerHighestLevel = hasPlayedMlb ? 'MLB' : currentLevel;

    const pa = s?.plateAppearances ?? null;
    const bb = s?.baseOnBalls      ?? null;
    const so = s?.strikeOuts       ?? null;

    return {
      mlbId:             p.mlbId,
      name:              p.name,
      // Only link to the MLB BBRef player page if they've actually played in MLB
      bbrefId:           hasPlayedMlb ? (p.bbrefId ?? null) : null,
      bbrefRegId:        p.bbrefRegId ?? null,
      team:              p.team,
      currentLevel,
      careerHighestLevel,
      positionGroup:     'hitting',
      G:       s?.gamesPlayed     ?? null,
      PA:      pa,
      AB:      s?.atBats          ?? null,
      doubles: s?.doubles         ?? null,
      triples: s?.triples         ?? null,
      HR:      s?.homeRuns        ?? null,
      RBI:     s?.rbi             ?? null,
      BB:      bb,
      SO:      so,
      SB:      s?.stolenBases     ?? null,
      CS:      s?.caughtStealing  ?? null,
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

export async function buildPitchingRows(rosterPlayers, statType, startDate, endDate, staticRows = [], season = '2026') {
  const livePlayers = rosterPlayers.filter(p => p.positionGroup === 'pitching' && p.mlbId);
  const liveIds = livePlayers.map(p => p.mlbId);

  const [statsMap, careerMlbSet] = await Promise.all([
    fetchMlbStats(liveIds, 'pitching', statType, startDate, endDate, season),
    fetchCareerMlbPlayers(liveIds, 'pitching'),
  ]);

  const rows = livePlayers.map(p => {
    const entry        = statsMap[p.mlbId];
    const s            = entry?.stat ?? null;
    const hasPlayedMlb = careerMlbSet.has(p.mlbId);
    // Indy/FA players' primary affiliation is independent — don't let a
    // brief affiliated stint override their roster classification.
    const NON_AFFILIATED = new Set(['Indy', 'FA']);
    const currentLevel = NON_AFFILIATED.has(p.level)
      ? p.level
      : (entry?.highestLevel ?? p.level);
    const careerHighestLevel = hasPlayedMlb ? 'MLB' : currentLevel;

    const ip  = s?.inningsPitched != null ? parseFloat(s.inningsPitched) : null;
    const so  = s?.strikeOuts  ?? null;
    const bb  = s?.baseOnBalls ?? null;
    const h   = s?.hits        ?? null;
    const hbp = s?.hitByPitch  ?? null;

    // BFP = outs recorded (from IP) + H + BB + HBP
    const ipOuts = ip != null ? ipToOuts(s.inningsPitched) : 0;
    const bfp    = ip != null ? (ipOuts + (h ?? 0) + (bb ?? 0) + (hbp ?? 0)) : null;

    const soPct   = (bfp && so != null && bfp > 0) ? so / bfp : null;
    const bbPct   = (bfp && bb != null && bfp > 0) ? bb / bfp : null;
    const sobbPct = (soPct != null && bbPct != null) ? soPct - bbPct : null;

    return {
      mlbId:             p.mlbId,
      name:              p.name,
      bbrefId:           hasPlayedMlb ? (p.bbrefId ?? null) : null,
      bbrefRegId:        p.bbrefRegId ?? null,
      team:              p.team,
      currentLevel,
      careerHighestLevel,
      positionGroup:     'pitching',
      G:        s?.gamesPlayed  ?? null,
      GS:       s?.gamesStarted ?? null,
      IP:       ip,
      ERA:      s?.era  != null ? parseFloat(s.era)  : null,
      WHIP:     s?.whip != null ? parseFloat(s.whip) : null,
      SOPct:    soPct,
      BBPct:    bbPct,
      SOBBPct:  sobbPct,
    };
  });

  return [...rows, ...staticRows];
}

export async function fetchTransactions(mlbIds, startDate, endDate) {
  if (!mlbIds.length) return [];

  const ids = mlbIds.join(',');
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

// ── Fielding / Defense ─────────────────────────────────────────────────────

/**
 * Fetch season fielding stats for all roster players with an mlbId.
 * Returns a map of position abbreviation → array of player entries
 * sorted by games played descending.
 *
 * When a player appears in multiple splits for the same position
 * (multi-team season), we take the maximum G value — which corresponds
 * to the season-aggregate split the API includes alongside per-team splits.
 */
export async function buildFieldingData(rosterPlayers, season = '2025') {
  const livePlayers = rosterPlayers.filter(p => p.mlbId);
  if (!livePlayers.length) return {};

  const ids       = livePlayers.map(p => p.mlbId).join(',');
  const playerMap = Object.fromEntries(livePlayers.map(p => [p.mlbId, p]));

  // Fetch fielding stats for each sport level in parallel
  const levelResults = await Promise.all(
    SPORT_LEVELS.map(async (level) => {
      try {
        const url = `/people?personIds=${ids}&hydrate=stats(group=fielding,type=season,season=${season},sportId=${level.id})`;
        return await mlbGet(url);
      } catch {
        return { people: [] };
      }
    })
  );

  // posAgg[pos] = Map<mlbId, { player, G, GS }>
  // Within each level call, take max G per position (handles multi-team aggregate splits).
  // Then SUM across levels (player may play at multiple levels in same season).
  const posAgg = {};

  for (const data of levelResults) {
    for (const person of (data.people || [])) {
      const player = playerMap[person.id];
      if (!player) continue;

      // Find max G per position within this level's response
      const levelPosG  = {};
      const levelPosGS = {};
      for (const statGroup of (person.stats || [])) {
        if (statGroup.group?.displayName !== 'fielding') continue;
        for (const split of (statGroup.splits || [])) {
          const pos = split.position?.abbreviation;
          if (!pos || pos === 'P') continue;   // exclude pitcher position
          const g  = split.stat?.gamesPlayed  ?? 0;
          const gs = split.stat?.gamesStarted ?? 0;
          if (g > (levelPosG[pos] ?? -1)) {
            levelPosG[pos]  = g;
            levelPosGS[pos] = gs;
          }
        }
      }

      // Add this level's max-G values to the running totals
      for (const [pos, g] of Object.entries(levelPosG)) {
        if (g === 0) continue;
        if (!posAgg[pos]) posAgg[pos] = new Map();
        const existing = posAgg[pos].get(person.id);
        posAgg[pos].set(person.id, {
          player,
          G:  (existing?.G  ?? 0) + g,
          GS: (existing?.GS ?? 0) + (levelPosGS[pos] ?? 0),
        });
      }
    }
  }

  // Convert to sorted arrays
  const result = {};
  for (const [pos, pMap] of Object.entries(posAgg)) {
    result[pos] = Array.from(pMap.values())
      .filter(e => e.G > 0)
      .sort((a, b) => b.G - a.G)
      .map(e => ({
        name:       e.player.name,
        mlbId:      e.player.mlbId,
        bbrefId:    e.player.bbrefId    ?? null,
        bbrefRegId: e.player.bbrefRegId ?? null,
        G:          e.G,
        GS:         e.GS,
      }));
  }
  return result;
}
