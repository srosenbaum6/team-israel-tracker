#!/usr/bin/env python3
"""
scrape_indy.py — Scrape Baseball Reference Register pages for indy-league players.

Run manually:  python scripts/scrape_indy.py
Run via CI:    .github/workflows/update-indy-stats.yml triggers this daily.

Outputs: data/indy_stats.json
"""

import json
import time
import re
from datetime import date
from pathlib import Path

import requests
import pandas as pd
from bs4 import BeautifulSoup

# ── Config ─────────────────────────────────────────────────────────────────

CURRENT_SEASON = str(date.today().year)
OUTPUT_PATH    = Path(__file__).parent.parent / "data" / "indy_stats.json"
ROSTER_PATH    = Path(__file__).parent.parent / "data" / "roster.json"

# BBRef robots.txt asks for a 3-second crawl delay — we respect that.
CRAWL_DELAY = 3.5

HEADERS = {
    "User-Agent": (
        "team-israel-tracker/1.0 "
        "(personal non-commercial project; "
        "github.com/YOUR_USERNAME/team-israel-tracker)"
    )
}

# ── Helpers ────────────────────────────────────────────────────────────────

def load_roster():
    with open(ROSTER_PATH) as f:
        data = json.load(f)
    # Only indy-level players with a bbrefRegId (register page ID)
    indy = [
        p for p in data["players"]
        if p["level"] == "Indy" and p.get("bbrefRegId")
    ]
    return indy


def fetch_register_page(bbref_reg_id: str) -> BeautifulSoup | None:
    url = f"https://www.baseball-reference.com/register/player.fcgi?id={bbref_reg_id}"
    print(f"  Fetching {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except Exception as e:
        print(f"  ERROR fetching {url}: {e}")
        return None


def parse_stat_row(row_dict: dict, season: str) -> dict | None:
    """
    Extract a single season row from the BBRef register table.
    Returns None if the row is not for the target season.
    """
    yr = str(row_dict.get("year_ID", "")).strip()
    if yr != season:
        return None

    def num(key, default=None):
        v = row_dict.get(key, "")
        if v in (None, "", "-"):
            return default
        try:
            return float(v)
        except (ValueError, TypeError):
            return default

    return row_dict  # Return full dict; we'll pick fields below


def scrape_player(player: dict) -> dict | None:
    """
    Fetch the BBRef register page and return a normalized stats dict,
    or None if no current-season stats are found.
    """
    reg_id  = player["bbrefRegId"]
    soup    = fetch_register_page(reg_id)
    if soup is None:
        return None

    pos_group = player.get("positionGroup", "hitting")

    # BBRef register pages embed commented-out HTML tables for hitting/pitching
    # We need to uncomment them first.
    html = str(soup)
    # Uncomment HTML comments that wrap tables
    html = re.sub(r'<!--(.*?)-->', r'\1', html, flags=re.DOTALL)
    soup2 = BeautifulSoup(html, "html.parser")

    table_id = "batting_standard" if pos_group == "hitting" else "pitching_standard"
    table = soup2.find("table", {"id": table_id})

    if table is None:
        print(f"  No {table_id} table found for {player['name']}")
        return None

    try:
        dfs = pd.read_html(str(table))
    except Exception as e:
        print(f"  Error parsing table for {player['name']}: {e}")
        return None

    if not dfs:
        return None

    df = dfs[0]
    df.columns = [str(c).strip() for c in df.columns]

    # Find the row for the current season
    year_col = next((c for c in df.columns if c.lower() in ("year", "year_id", "yr")), None)
    if year_col is None:
        print(f"  Could not find year column for {player['name']}. Columns: {list(df.columns)}")
        return None

    df[year_col] = df[year_col].astype(str).str.strip()
    season_rows = df[df[year_col] == CURRENT_SEASON]

    if season_rows.empty:
        print(f"  No {CURRENT_SEASON} stats for {player['name']}")
        return None

    # If multiple rows (different teams in same season), take the last "total" row
    # BBRef marks totals as "TOT" in the team column; fall back to last row
    team_col = next((c for c in df.columns if c.lower() in ("tm", "team")), None)
    row = season_rows.iloc[-1].to_dict()

    def g(key, alt=None, default=None):
        for k in ([key] + ([alt] if alt else [])):
            v = row.get(k)
            if v not in (None, "", "-", "nan"):
                try:
                    return float(str(v).replace(",", ""))
                except (ValueError, TypeError):
                    pass
        return default

    if pos_group == "hitting":
        ab  = g("AB")
        h   = g("H")
        bb  = g("BB")
        pa  = g("PA")
        avg = round(h / ab, 3) if (ab and h is not None) else None
        return {
            "playerName": player["name"],
            "playerId":   player.get("mlbId"),
            "bbrefId":    player.get("bbrefId"),
            "team":       player["team"],
            "level":      player["level"],
            "season":     CURRENT_SEASON,
            "stats": {
                "G":       g("G"),
                "PA":      pa,
                "AB":      ab,
                "H":       h,
                "doubles": g("2B"),
                "triples": g("3B"),
                "HR":      g("HR"),
                "RBI":     g("RBI"),
                "BB":      bb,
                "SO":      g("SO"),
                "SB":      g("SB"),
                "AVG":     avg,
                "OBP":     g("OBP"),
                "SLG":     g("SLG"),
                "OPS":     g("OPS"),
            }
        }
    else:  # pitching
        ip  = g("IP")
        so  = g("SO")
        bb  = g("BB")
        k9  = round(so * 9 / ip, 2)  if (ip and so is not None and ip > 0) else None
        bb9 = round(bb * 9 / ip, 2)  if (ip and bb is not None and ip > 0) else None
        return {
            "playerName": player["name"],
            "playerId":   player.get("mlbId"),
            "bbrefId":    player.get("bbrefId"),
            "team":       player["team"],
            "level":      player["level"],
            "season":     CURRENT_SEASON,
            "stats": {
                "G":    g("G"),
                "GS":   g("GS"),
                "IP":   ip,
                "W":    g("W"),
                "L":    g("L"),
                "H":    g("H"),
                "ER":   g("ER"),
                "BB":   bb,
                "SO":   so,
                "ERA":  g("ERA"),
                "WHIP": g("WHIP"),
                "K9":   k9,
                "BB9":  bb9,
            }
        }


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    print(f"Scraping BBRef register pages for {CURRENT_SEASON} indy stats...")
    players = load_roster()

    if not players:
        print("No indy players with bbrefRegId found in roster.json")

    hitting  = []
    pitching = []

    for i, player in enumerate(players):
        print(f"[{i+1}/{len(players)}] {player['name']} ({player['level']})")
        result = scrape_player(player)
        if result:
            if player.get("positionGroup") == "hitting":
                hitting.append(result)
            else:
                pitching.append(result)
        # Respect crawl delay between requests
        if i < len(players) - 1:
            time.sleep(CRAWL_DELAY)

    output = {
        "_note": "Auto-generated by scripts/scrape_indy.py — do not edit manually.",
        "lastUpdated": date.today().isoformat(),
        "season": CURRENT_SEASON,
        "hitting":  hitting,
        "pitching": pitching,
    }

    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"\nWrote {len(hitting)} hitting + {len(pitching)} pitching rows to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
