#!/usr/bin/env python3
"""
generate_weekly_report.py — Generate weekly Team Israel stats report.

Run via CI: .github/workflows/weekly_report.yml (every Friday 9 AM UTC)
Run manually:
  python scripts/generate_weekly_report.py

Optional env var overrides for manual/backfill runs:
  REPORT_END_DATE   YYYY-MM-DD  (default: today)
  REPORT_START_DATE YYYY-MM-DD  (default: 7 days ago)
  REPORT_SEASON     YYYY        (default: current year)

Email env vars (set as GitHub Actions secrets):
  GMAIL_USER         your.email@gmail.com
  GMAIL_APP_PASSWORD app password from Google Account > Security > App Passwords
  REPORT_SUBSCRIBERS comma-separated list of recipient emails

Outputs (committed by workflow):
  data/weekly_reports/YYYY-MM-DD.json   the report for this week
  data/weekly_reports/index.json        updated index of all reports
"""

import json
import os
import smtplib
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import requests

# ── Config ────────────────────────────────────────────────────────────────────

MLB_API      = "https://statsapi.mlb.com/api/v1"
ROSTER_PATH  = Path(__file__).parent.parent / "data" / "roster.json"
REPORTS_DIR  = Path(__file__).parent.parent / "data" / "weekly_reports"
INDEX_PATH   = REPORTS_DIR / "index.json"

# Mirror of SPORT_LEVELS in api.js
SPORT_LEVELS = [
    {"id": 1,  "abbrev": "MLB"},
    {"id": 11, "abbrev": "AAA"},
    {"id": 12, "abbrev": "AA"},
    {"id": 13, "abbrev": "A+"},
    {"id": 14, "abbrev": "A"},
    {"id": 16, "abbrev": "Rk"},
]

PLAYER_CHUNK = 25    # max playerIds per MLB API call (stay polite)
API_DELAY    = 0.3   # seconds between chunk calls
NEWS_DELAY   = 1.0   # seconds between Google News RSS calls

# Highlight thresholds
MIN_PA_WEEKLY    = 15
MIN_PA_SEASON    = 50
MIN_IP_WEEKLY    = 3.0
MIN_IP_SEASON    = 10.0

HEADERS = {"User-Agent": "team-israel-tracker/1.0 (github.com/srosenbaum6/team-israel-tracker)"}

# ── Data loading ──────────────────────────────────────────────────────────────

def load_roster():
    """Returns (hitters, pitchers, all_mlb_ids, all_players)."""
    with open(ROSTER_PATH) as f:
        data = json.load(f)
    players = [p for p in data["players"] if p.get("mlbId")]
    hitters  = [p for p in players if p.get("positionGroup") == "hitting"]
    pitchers = [p for p in players if p.get("positionGroup") == "pitching"]
    all_ids  = [p["mlbId"] for p in players]
    return hitters, pitchers, all_ids, players

# ── MLB API helpers ───────────────────────────────────────────────────────────

def mlb_get(path):
    resp = requests.get(f"{MLB_API}{path}", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()

def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

def ip_to_outs(ip_str):
    """Convert '5.2' innings-pitched notation to total outs. Mirrors api.js ipToOuts."""
    if not ip_str:
        return 0
    f = float(ip_str)
    return int(f) * 3 + round((f % 1) * 10)

def outs_to_ip(outs):
    """Convert total outs back to IP string. Mirrors api.js outsToIp."""
    return f"{outs // 3}.{outs % 3}"

def ip_decimal(ip_str):
    """Convert IP string to decimal for threshold comparisons (e.g. '5.2' → 5.667)."""
    if not ip_str:
        return 0.0
    f = float(ip_str)
    return int(f) + round((f % 1) * 10) / 3

def merge_stats(a, b, group):
    """
    Merge two stat dicts by summing counting fields.
    Mirrors combinedStats() in api.js.
    """
    COUNTING_HITTING = [
        "gamesPlayed", "hits", "doubles", "triples", "homeRuns",
        "rbi", "baseOnBalls", "strikeOuts", "stolenBases", "caughtStealing",
        "plateAppearances", "atBats", "runs", "hitByPitch", "sacFlies",
    ]
    COUNTING_PITCHING = [
        "gamesPlayed", "gamesStarted", "hits", "homeRuns", "baseOnBalls",
        "strikeOuts", "earnedRuns", "hitBatsmen", "wins", "losses", "saves",
    ]
    counting = COUNTING_PITCHING if group == "pitching" else COUNTING_HITTING
    merged = {}
    for k in counting:
        if k in a or k in b:
            merged[k] = (a.get(k) or 0) + (b.get(k) or 0)

    if group == "pitching":
        total_outs = ip_to_outs(a.get("inningsPitched")) + ip_to_outs(b.get("inningsPitched"))
        merged["inningsPitched"] = outs_to_ip(total_outs)

    return merged

def fetch_stats_for_group(player_ids, group, start_date, end_date, season):
    """
    Fetch byDateRange stats across all sport levels.
    Returns {mlbId: {"stat": {...}, "highestLevel": "MLB"|"AAA"|...}}
    Mirrors fetchMlbStats() in api.js.
    """
    result = {}
    for level in SPORT_LEVELS:
        for chunk in chunks(player_ids, PLAYER_CHUNK):
            ids_str = ",".join(str(i) for i in chunk)
            params = (
                f"group={group},type=byDateRange,season={season},"
                f"startDate={start_date},endDate={end_date},"
                f"sportId={level['id']}"
            )
            url = f"/people?personIds={ids_str}&hydrate=stats({params})"
            try:
                data = mlb_get(url)
                for person in data.get("people", []):
                    stat_arr = person.get("stats", [])
                    match = next(
                        (s for s in stat_arr
                         if s.get("group", {}).get("displayName") == group
                         and s.get("splits")),
                        None
                    )
                    if not match:
                        continue
                    pid = person["id"]
                    stat = match["splits"][0]["stat"]
                    if pid not in result:
                        result[pid] = {"stat": stat, "highestLevel": level["abbrev"]}
                    else:
                        # Player appeared at multiple levels — merge counting stats
                        result[pid]["stat"] = merge_stats(result[pid]["stat"], stat, group)
            except Exception as e:
                print(f"    Warning: API error for {group} level={level['abbrev']}: {e}")
            time.sleep(API_DELAY)
    return result

def fetch_season_stats_for_group(player_ids, group, season):
    """
    Fetch full-season stats (type=season) across all sport levels.
    Returns same format as fetch_stats_for_group.
    """
    result = {}
    for level in SPORT_LEVELS:
        for chunk in chunks(player_ids, PLAYER_CHUNK):
            ids_str = ",".join(str(i) for i in chunk)
            params = f"group={group},type=season,season={season},sportId={level['id']}"
            url = f"/people?personIds={ids_str}&hydrate=stats({params})"
            try:
                data = mlb_get(url)
                for person in data.get("people", []):
                    stat_arr = person.get("stats", [])
                    match = next(
                        (s for s in stat_arr
                         if s.get("group", {}).get("displayName") == group
                         and s.get("splits")),
                        None
                    )
                    if not match:
                        continue
                    pid = person["id"]
                    stat = match["splits"][0]["stat"]
                    if pid not in result:
                        result[pid] = {"stat": stat, "highestLevel": level["abbrev"]}
                    else:
                        result[pid]["stat"] = merge_stats(result[pid]["stat"], stat, group)
            except Exception as e:
                print(f"    Warning: Season API error for {group} level={level['abbrev']}: {e}")
            time.sleep(API_DELAY)
    return result

def fetch_transactions(all_ids, start_date, end_date):
    """
    Fetch transactions from MLB and AAA APIs.
    Mirrors fetchTransactions() in api.js.
    Only returns transactions for players on the roster.
    """
    roster_id_set = set(all_ids)
    txns = []
    seen = set()
    for sport_id in [1, 11]:
        ids_str = ",".join(str(i) for i in all_ids)
        try:
            data = mlb_get(
                f"/transactions?playerIds={ids_str}"
                f"&startDate={start_date}&endDate={end_date}&sportId={sport_id}"
            )
            for t in data.get("transactions", []):
                tid = t.get("id")
                if tid in seen:
                    continue
                seen.add(tid)
                player = t.get("person", {}).get("fullName", "")
                if not player.strip():
                    continue
                # Only include transactions for players actually on our roster
                mlb_id = t.get("person", {}).get("id")
                if mlb_id not in roster_id_set:
                    continue
                txns.append({
                    "date":        t.get("date") or t.get("effectiveDate", ""),
                    "player":      player,
                    "mlbId":       mlb_id,
                    "type":        t.get("typeDesc") or t.get("transactionType", "—"),
                    "fromTeam":    t.get("fromTeam", {}).get("name", "—") if t.get("fromTeam") else "—",
                    "toTeam":      t.get("toTeam",   {}).get("name", "—") if t.get("toTeam")   else "—",
                    "description": t.get("description", ""),
                })
        except Exception as e:
            print(f"    Warning: transaction fetch failed sportId={sport_id}: {e}")
    txns.sort(key=lambda t: t["date"], reverse=True)
    return txns

# ── Rate stat helpers ─────────────────────────────────────────────────────────

def calc_hitting_rates(s):
    ab  = s.get("atBats") or 0
    h   = s.get("hits") or 0
    bb  = s.get("baseOnBalls") or 0
    hbp = s.get("hitByPitch") or 0
    sf  = s.get("sacFlies") or 0
    d   = s.get("doubles") or 0
    t   = s.get("triples") or 0
    hr  = s.get("homeRuns") or 0
    pa  = s.get("plateAppearances") or 0

    avg = round(h / ab, 3) if ab > 0 else None
    obp_n = h + bb + hbp
    obp_d = ab + bb + hbp + sf
    obp = round(obp_n / obp_d, 3) if obp_d > 0 else None
    tb  = h + d + 2*t + 3*hr
    slg = round(tb / ab, 3) if ab > 0 else None
    ops = round((obp or 0) + (slg or 0), 3) if (obp is not None and slg is not None) else None

    so = s.get("strikeOuts") or 0
    so_pct = round(so / pa, 3) if pa > 0 else None
    bb_pct = round(bb / pa, 3) if pa > 0 else None

    return {
        "AVG": avg, "OBP": obp, "SLG": slg, "OPS": ops,
        "SO_PCT": so_pct, "BB_PCT": bb_pct,
    }

def calc_pitching_rates(s):
    ip_str = s.get("inningsPitched")
    ip = ip_decimal(ip_str)
    er = s.get("earnedRuns") or 0
    bb = s.get("baseOnBalls") or 0
    h  = s.get("hits") or 0
    so = s.get("strikeOuts") or 0

    # BFP approximation (same as api.js)
    outs = ip_to_outs(ip_str)
    bfp  = outs + h + bb + (s.get("hitBatsmen") or 0)

    era  = round(er * 9 / ip, 2)  if ip > 0 else None
    whip = round((bb + h) / ip, 2) if ip > 0 else None
    so_pct  = round(so / bfp, 3)        if bfp > 0 else None
    bb_pct  = round(bb / bfp, 3)        if bfp > 0 else None
    so_bb_pct = round((so_pct or 0) - (bb_pct or 0), 3) \
                if (so_pct is not None and bb_pct is not None) else None

    return {
        "ERA": era, "WHIP": whip,
        "SO_PCT": so_pct, "BB_PCT": bb_pct, "SO_BB_PCT": so_bb_pct,
        "IP": ip_str,
    }

def fmt_rate(val, decimals=3):
    """Format a rate like .312 (no leading zero), or '—' if None."""
    if val is None:
        return "—"
    s = f"{val:.{decimals}f}"
    return s.lstrip("0") if s.startswith("0") else s

def fmt_pct(val):
    """Format a fraction as percentage string like '24.1%'."""
    if val is None:
        return "—"
    return f"{val * 100:.1f}%"

# ── Highlight generation ──────────────────────────────────────────────────────

def find_hitter_highlights(hitters, stats_map, min_pa=MIN_PA_WEEKLY):
    """
    Returns a list of highlight dicts.
    Ranked by OPS (primary) with a separate HR leader callout.
    """
    qualified = []
    for p in hitters:
        entry = stats_map.get(p["mlbId"])
        if not entry:
            continue
        s = entry["stat"]
        pa = s.get("plateAppearances") or 0
        if pa < min_pa:
            continue
        rates = calc_hitting_rates(s)
        qualified.append({
            "name":   p["name"],
            "team":   p.get("team", ""),
            "level":  entry["highestLevel"],
            "PA":     pa,
            "HR":     s.get("homeRuns") or 0,
            "RBI":    s.get("rbi") or 0,
            "SB":     s.get("stolenBases") or 0,
            "G":      s.get("gamesPlayed") or 0,
            **rates,
        })

    highlights = []

    # Top 3 by OPS
    by_ops = sorted(
        [q for q in qualified if q["OPS"] is not None],
        key=lambda q: q["OPS"], reverse=True
    )
    for q in by_ops[:3]:
        highlights.append({
            "type":   "top_hitter",
            "player": q["name"],
            "team":   q["team"],
            "level":  q["level"],
            "stats":  q,
            "note":   (
                f"{q['name']} — {q['PA']} PA, "
                f"OPS {fmt_rate(q['OPS'])} "
                f"({fmt_rate(q['AVG'])}/{fmt_rate(q['OBP'])}/{fmt_rate(q['SLG'])}) "
                f"at {q['level']}"
            ),
        })

    # HR highlights (≥1 HR)
    hr_leaders = sorted(
        [q for q in qualified if q["HR"] >= 1],
        key=lambda q: (q["HR"], q["OPS"] or 0), reverse=True
    )
    for q in hr_leaders:
        highlights.append({
            "type":   "hr_highlight",
            "player": q["name"],
            "team":   q["team"],
            "level":  q["level"],
            "stats":  q,
            "note":   (
                f"{q['name']} hit {q['HR']} HR"
                + (f" with {q['RBI']} RBI" if q["RBI"] >= 1 else "")
                + f" ({q['level']})"
            ),
        })

    return highlights

def find_pitcher_highlights(pitchers, stats_map, min_ip=MIN_IP_WEEKLY):
    """
    Top 3 pitchers by K-BB% (SO% − BB%), minimum min_ip innings.
    """
    qualified = []
    for p in pitchers:
        entry = stats_map.get(p["mlbId"])
        if not entry:
            continue
        s = entry["stat"]
        ip = ip_decimal(s.get("inningsPitched"))
        if ip < min_ip:
            continue
        rates = calc_pitching_rates(s)
        qualified.append({
            "name":    p["name"],
            "team":    p.get("team", ""),
            "level":   entry["highestLevel"],
            "IP":      s.get("inningsPitched"),
            "SO":      s.get("strikeOuts") or 0,
            "BB":      s.get("baseOnBalls") or 0,
            "G":       s.get("gamesPlayed") or 0,
            "GS":      s.get("gamesStarted") or 0,
            **rates,
        })

    highlights = []

    # Top 3 by K-BB%
    by_kbb = sorted(
        [q for q in qualified if q["SO_BB_PCT"] is not None],
        key=lambda q: q["SO_BB_PCT"], reverse=True
    )
    for q in by_kbb[:3]:
        highlights.append({
            "type":   "top_pitcher",
            "player": q["name"],
            "team":   q["team"],
            "level":  q["level"],
            "stats":  q,
            "note":   (
                f"{q['name']} — {q['IP']} IP, "
                f"K-BB% {fmt_pct(q['SO_BB_PCT'])}, "
                f"ERA {fmt_rate(q['ERA'], 2) if q['ERA'] is not None else '—'} "
                f"({q['level']})"
            ),
        })

    return highlights

# ── News fetching (Google News RSS — no API key required) ─────────────────────

def fetch_news_items(player_names, max_per_query=3):
    """
    Fetches recent news from Google News RSS for Team Israel and top performers.
    Returns list of {title, url, source, published, query}.
    All stdlib — no external dependencies.
    """
    queries = ["Team Israel baseball"] + [f'"{name}" baseball' for name in player_names]
    results = []
    seen_urls = set()

    for query in queries:
        encoded = urllib.parse.quote(query)
        url = f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "team-israel-tracker/1.0"
            })
            with urllib.request.urlopen(req, timeout=10) as r:
                content = r.read()
            tree = ET.fromstring(content)
            for item in tree.findall(".//item")[:max_per_query]:
                link = item.findtext("link") or ""
                title = item.findtext("title") or ""
                if not link or link in seen_urls:
                    continue
                seen_urls.add(link)
                results.append({
                    "title":     title,
                    "url":       link,
                    "source":    item.findtext("source") or "",
                    "published": item.findtext("pubDate") or "",
                    "query":     query,
                })
        except Exception as e:
            print(f"    News fetch skipped for '{query}': {e}")
        time.sleep(NEWS_DELAY)

    return results

# ── Report assembly ───────────────────────────────────────────────────────────

def build_window_data(hitters, pitchers, stats_map_h, stats_map_p, min_pa, min_ip):
    """Build highlights for one time window."""
    return {
        "hittingHighlights":  find_hitter_highlights(hitters,  stats_map_h, min_pa),
        "pitchingHighlights": find_pitcher_highlights(pitchers, stats_map_p, min_ip),
    }

def build_report(start_date, end_date, season):
    """Full report assembly. Returns the report dict."""
    hitters, pitchers, all_ids, all_players = load_roster()
    hitter_ids  = [p["mlbId"] for p in hitters]
    pitcher_ids = [p["mlbId"] for p in pitchers]

    # ── Last 7 days ──
    print(f"  Fetching last-7 hitting stats ({len(hitter_ids)} players)...")
    last7_h = fetch_stats_for_group(hitter_ids,  "hitting",  start_date, end_date, season)
    print(f"  Fetching last-7 pitching stats ({len(pitcher_ids)} players)...")
    last7_p = fetch_stats_for_group(pitcher_ids, "pitching", start_date, end_date, season)

    # ── Last 30 days ──
    start_30 = (date.fromisoformat(end_date) - timedelta(days=30)).isoformat()
    print(f"  Fetching last-30 hitting stats...")
    last30_h = fetch_stats_for_group(hitter_ids,  "hitting",  start_30, end_date, season)
    print(f"  Fetching last-30 pitching stats...")
    last30_p = fetch_stats_for_group(pitcher_ids, "pitching", start_30, end_date, season)

    # ── Full season ──
    print(f"  Fetching season hitting stats...")
    season_h = fetch_season_stats_for_group(hitter_ids,  "hitting",  season)
    print(f"  Fetching season pitching stats...")
    season_p = fetch_season_stats_for_group(pitcher_ids, "pitching", season)

    # ── Transactions ──
    print(f"  Fetching transactions...")
    transactions = fetch_transactions(all_ids, start_date, end_date)

    # ── Highlights for each window ──
    print("  Computing highlights...")
    last7_data   = build_window_data(hitters, pitchers, last7_h,   last7_p,   MIN_PA_WEEKLY,  MIN_IP_WEEKLY)
    last30_data  = build_window_data(hitters, pitchers, last30_h,  last30_p,  MIN_PA_WEEKLY,  MIN_IP_WEEKLY)
    season_data  = build_window_data(hitters, pitchers, season_h,  season_p,  MIN_PA_SEASON,  MIN_IP_SEASON)

    # ── News ──
    # Search for top performers from last 7 days + transaction players
    top_performer_names = list({
        h["player"]
        for h in last7_data["hittingHighlights"] + last7_data["pitchingHighlights"]
    })
    txn_player_names = list({t["player"] for t in transactions[:5]})
    news_names = (top_performer_names + txn_player_names)[:10]

    print(f"  Fetching news for {len(news_names) + 1} queries...")
    news_raw = fetch_news_items(news_names)

    # Only keep articles whose title mentions at least one roster player
    # (the general "Team Israel baseball" query can surface non-roster names)
    all_player_names = [p["name"] for p in all_players]
    # Use last names for matching so "Goldschmidt" matches "Paul Goldschmidt"
    last_names = {n.split()[-1].lower() for n in all_player_names if n.split()}
    def _mentions_roster_player(title):
        title_lower = title.lower()
        return any(ln in title_lower for ln in last_names)

    _FANTASY_TERMS = {'fantasy', 'rotoballer', 'rotoworld', 'fantasypros',
                      'rotowire', 'fantrax', 'fanduel', 'draftkings'}
    def _is_fantasy(item):
        text = (item.get('title', '') + ' ' + item.get('source', '')).lower()
        return any(t in text for t in _FANTASY_TERMS)

    news = [n for n in news_raw if _mentions_roster_player(n["title"]) and not _is_fantasy(n)]

    # ── Activity summary ──
    all_active = set(last7_h.keys()) | set(last7_p.keys())
    level_counts = {}
    for pid in all_active:
        lvl = (last7_h.get(pid) or last7_p.get(pid) or {}).get("highestLevel", "?")
        level_counts[lvl] = level_counts.get(lvl, 0) + 1

    return {
        "_note":        "Auto-generated by scripts/generate_weekly_report.py",
        "weekEnding":   end_date,
        "weekStarting": start_date,
        "season":       season,
        "generatedAt":  date.today().isoformat(),
        "summary": {
            "activePlayers":    len(all_active),
            "levelBreakdown":   level_counts,
            "totalTransactions": len(transactions),
        },
        "last7":         last7_data,
        "last30":        last30_data,
        "seasonToDate":  season_data,
        "transactions":  transactions,
        "news":          news,
        "rawStats": {
            "last7":  {
                "hitting":  [{"mlbId": pid, **e} for pid, e in last7_h.items()],
                "pitching": [{"mlbId": pid, **e} for pid, e in last7_p.items()],
            },
            "last30": {
                "hitting":  [{"mlbId": pid, **e} for pid, e in last30_h.items()],
                "pitching": [{"mlbId": pid, **e} for pid, e in last30_p.items()],
            },
            "season": {
                "hitting":  [{"mlbId": pid, **e} for pid, e in season_h.items()],
                "pitching": [{"mlbId": pid, **e} for pid, e in season_p.items()],
            },
        },
    }

# ── File I/O ──────────────────────────────────────────────────────────────────

def save_report(report, end_date):
    """Write report JSON and update index.json."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    report_path = REPORTS_DIR / f"{end_date}.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"  Wrote {report_path}")

    # Update index (upsert by weekEnding)
    if INDEX_PATH.exists():
        index = json.loads(INDEX_PATH.read_text())
    else:
        index = {"reports": []}

    # Remove existing entry for this date (idempotent re-run)
    entries = [r for r in index.get("reports", []) if r["weekEnding"] != end_date]
    entries.append({
        "weekEnding":        end_date,
        "weekStarting":      report["weekStarting"],
        "season":            report["season"],
        "filename":          f"{end_date}.json",
        "activePlayers":     report["summary"]["activePlayers"],
        "totalTransactions": report["summary"]["totalTransactions"],
    })
    entries.sort(key=lambda r: r["weekEnding"], reverse=True)
    index["reports"] = entries
    INDEX_PATH.write_text(json.dumps(index, indent=2))
    print(f"  Updated index ({len(entries)} reports total)")

# ── Email ─────────────────────────────────────────────────────────────────────

def _fmt_stat(col, val):
    """Format a single stat value for the email table."""
    if val is None:
        return '—'
    rate_cols = {'AVG', 'OBP', 'SLG', 'OPS'}
    pct_cols  = {'SO_PCT', 'BB_PCT', 'SO_BB_PCT'}
    if col in rate_cols:
        s = f"{float(val):.3f}"
        return s.lstrip('0') or '.000'
    if col in pct_cols:
        return f"{float(val) * 100:.1f}%"
    return str(val)

def _highlights_rows_html(highlights, h_type, cols):
    """Render up to 5 highlights of a given type as <tr> rows."""
    filtered = [h for h in highlights if h["type"] == h_type][:5]
    if not filtered:
        return f'<tr><td colspan="{len(cols)}" style="color:#9ca3af;font-style:italic;padding:8px;">None this week.</td></tr>'
    rows = []
    for h in filtered:
        cells = "".join(
            f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;'>{_fmt_stat(c, h['stats'].get(c))}</td>"
            for c in cols
        )
        rows.append(
            f"<tr>"
            f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;font-weight:600;'>{h['player']}</td>"
            f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;'>{h['level']}</td>"
            f"{cells}"
            f"</tr>"
        )
    return "\n".join(rows)

def _section_html(title, table_html):
    return f"""
<h2 style="font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;
           color:#003399;border-bottom:2px solid #e9eaec;padding-bottom:6px;
           margin:24px 0 12px;">{title}</h2>
{table_html}
"""

def _leaderboard_html(window_data, pa_label, ip_label):
    """Render hitter + pitcher leaderboard tables for one time window."""
    # Hitters table
    hit_rows = _highlights_rows_html(
        window_data["hittingHighlights"], "top_hitter",
        ["G", "PA", "AVG", "OBP", "SLG", "OPS"]
    )
    # Pitchers table
    pit_rows = _highlights_rows_html(
        window_data["pitchingHighlights"], "top_pitcher",
        ["G", "IP", "SO_PCT", "BB_PCT", "SO_BB_PCT", "ERA"]
    )

    th = "style='background:#f5f6f8;padding:6px 10px;text-align:left;font-weight:600;font-size:12px;'"
    return f"""
<p style="font-size:12px;color:#9ca3af;margin-bottom:8px;font-style:italic;">
  Min {pa_label} PA for hitters / {ip_label} IP for pitchers
</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
  <thead><tr>
    <th {th}>Hitter</th><th {th}>Level</th>
    <th {th}>G</th><th {th}>PA</th>
    <th {th}>AVG</th><th {th}>OBP</th><th {th}>SLG</th><th {th}>OPS</th>
  </tr></thead>
  <tbody>{hit_rows}</tbody>
</table>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
  <thead><tr>
    <th {th}>Pitcher</th><th {th}>Level</th>
    <th {th}>G</th><th {th}>IP</th>
    <th {th}>SO%</th><th {th}>BB%</th><th {th}>K-BB%</th><th {th}>ERA</th>
  </tr></thead>
  <tbody>{pit_rows}</tbody>
</table>
"""

def _txn_section_html(transactions):
    th = "style='background:#f5f6f8;padding:6px 10px;text-align:left;font-weight:600;font-size:12px;'"
    if not transactions:
        return '<p style="color:#9ca3af;font-style:italic;font-size:13px;">No transactions this week.</p>'
    rows = "\n".join(
        f"<tr>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;'>{t['date']}</td>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;font-weight:600;'>{t['player']}</td>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;'>{t['type']}</td>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #e9eaec;'>{t['toTeam']}</td>"
        f"</tr>"
        for t in transactions[:15]
    )
    return f"""
<table style="width:100%;border-collapse:collapse;font-size:13px;">
  <thead><tr>
    <th {th}>Date</th><th {th}>Player</th><th {th}>Type</th><th {th}>To</th>
  </tr></thead>
  <tbody>{rows}</tbody>
</table>
"""

def _news_section_html(news):
    if not news:
        return '<p style="color:#9ca3af;font-style:italic;font-size:13px;">No news found this week.</p>'
    items = "\n".join(
        f'<li style="margin-bottom:8px;">'
        f'<a href="{n["url"]}" style="color:#003399;font-weight:600;">{n["title"]}</a>'
        + (f' <span style="color:#9ca3af;font-size:12px;">— {n["source"]}</span>' if n.get("source") else "")
        + "</li>"
        for n in news[:15]
    )
    return f'<ul style="padding-left:18px;font-size:13px;">{items}</ul>'

def build_email_html(report):
    """Returns full HTML email string."""
    week    = report["weekEnding"]
    wstart  = report["weekStarting"]
    summary = report["summary"]

    no_activity = ""
    if summary["activePlayers"] == 0:
        no_activity = (
            '<p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;'
            'padding:10px 14px;font-size:13px;margin-bottom:16px;">'
            '⚠️ No players recorded stats this week — off-season or no games scheduled.</p>'
        )

    level_str = ", ".join(
        f"{n} {lvl}"
        for lvl, n in sorted(summary["levelBreakdown"].items(),
                              key=lambda x: -x[1])
    ) or "none"

    tracker_url = "https://srosenbaum6.github.io/team-israel-tracker/"

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,Arial,sans-serif;color:#111827;">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.10);">

  <!-- Header -->
  <div style="background:#003399;color:#fff;padding:24px 28px;">
    <h1 style="font-size:20px;font-weight:700;margin:0;">Team Israel Weekly Report</h1>
    <p style="font-size:13px;opacity:.8;margin:6px 0 0;">
      Week of {wstart} &ndash; {week} &nbsp;&middot;&nbsp;
      {summary['activePlayers']} players active ({level_str}) &nbsp;&middot;&nbsp;
      {summary['totalTransactions']} transaction{'s' if summary['totalTransactions'] != 1 else ''}
    </p>
  </div>

  <!-- Body -->
  <div style="padding:24px 28px;">
    {no_activity}

    {_section_html("Season to Date",
        _leaderboard_html(report["seasonToDate"], MIN_PA_SEASON, MIN_IP_SEASON))}

    {_section_html("Last 30 Days",
        _leaderboard_html(report["last30"], MIN_PA_WEEKLY, MIN_IP_WEEKLY))}

    {_section_html("This Week (Last 7 Days)",
        _leaderboard_html(report["last7"], MIN_PA_WEEKLY, MIN_IP_WEEKLY))}

    {_section_html("In the News", _news_section_html(report["news"]))}

    {_section_html("Transactions", _txn_section_html(report["transactions"]))}

    <!-- CTA -->
    <div style="text-align:center;margin:28px 0 8px;">
      <a href="{tracker_url}"
         style="display:inline-block;background:#003399;color:#fff;font-weight:700;
                font-size:14px;text-decoration:none;padding:12px 28px;
                border-radius:6px;letter-spacing:.3px;">
        View Full Dashboard &rarr;
      </a>
      <p style="font-size:11px;color:#9ca3af;margin:8px 0 0;">
        Stats, standings, defense, and more at the Team Israel Tracker
      </p>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f5f6f8;padding:14px 28px;font-size:12px;color:#9ca3af;text-align:center;">
    <a href="{tracker_url}" style="color:#003399;">View full tracker</a>
    &nbsp;|&nbsp; Stats from
    <a href="https://statsapi.mlb.com" style="color:#003399;">MLB Stats API</a>
    &amp;
    <a href="https://www.baseball-reference.com" style="color:#003399;">Baseball Reference</a>
  </div>

</div>
</body>
</html>"""

def send_email(report, subscribers):
    """Send HTML email via Gmail SMTP. Skips gracefully if credentials missing."""
    gmail_user = os.environ.get("GMAIL_USER")
    gmail_pass = os.environ.get("GMAIL_APP_PASSWORD")
    if not gmail_user or not gmail_pass:
        print("  Email env vars not set — skipping email.")
        return

    html_body = build_email_html(report)
    week      = report["weekEnding"]
    subject   = f"Team Israel Weekly Report — Week Ending {week}"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = gmail_user
    msg["To"]      = ", ".join(subscribers)
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(gmail_user, gmail_pass)
            server.sendmail(gmail_user, subscribers, msg.as_string())
        print(f"  Emailed to {len(subscribers)} subscriber(s).")
    except Exception as e:
        print(f"  Email failed: {e}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    today_str = date.today().isoformat()
    # Use `or` so blank strings from empty workflow_dispatch inputs
    # fall back to defaults, just like missing env vars do.
    end_date   = os.environ.get("REPORT_END_DATE")   or today_str
    start_date = os.environ.get("REPORT_START_DATE") or (date.today() - timedelta(days=7)).isoformat()
    season     = os.environ.get("REPORT_SEASON")     or str(date.today().year)

    print(f"Generating report: {start_date} → {end_date} (season {season})")

    report = build_report(start_date, end_date, season)
    save_report(report, end_date)

    subscribers_raw = os.environ.get("REPORT_SUBSCRIBERS", "")
    subscribers = [s.strip() for s in subscribers_raw.split(",") if s.strip()]
    if subscribers:
        send_email(report, subscribers)
    else:
        print("  No REPORT_SUBSCRIBERS set — skipping email.")

    print("Done.")

if __name__ == "__main__":
    main()
