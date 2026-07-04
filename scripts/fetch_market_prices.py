#!/usr/bin/env python3
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def unix_time(value):
    return int(time.mktime(parse_date(value).timetuple()))


def yahoo_symbol(ticker):
    return ticker.upper()


def fetch_yahoo_daily(ticker, start, end):
    params = urlencode({
        "period1": unix_time(start),
        "period2": unix_time(end) + 86400,
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    })
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{yahoo_symbol(ticker)}?{params}"
    request = Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
    })

    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        error = payload.get("chart", {}).get("error") or {}
        raise RuntimeError(error.get("description") or f"No Yahoo chart result for {ticker}")

    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    rows = []
    for timestamp, close in zip(timestamps, closes):
        if close is None:
            continue
        date = datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()
        if start <= date <= end:
            rows.append({"date": date, "close": round(float(close), 6)})

    if len(rows) < 2:
        raise RuntimeError(f"Too few daily prices for {ticker}")
    return rows


def ranges_from_existing(path):
    data = json.loads(path.read_text()) if path.exists() else {}
    prices = data.get("prices") or {}
    ranges = {}
    for ticker, rows in prices.items():
        rows = [row for row in rows if row.get("date")]
        if rows:
            ranges[ticker] = (rows[0]["date"], rows[-1]["date"])
    return ranges, data


def main():
    parser = argparse.ArgumentParser(description="Fetch public daily close prices for market.prices.json.")
    parser.add_argument("--input", default="market.prices.json", help="Existing market price JSON used for ticker/date ranges.")
    parser.add_argument("--output", default="market.prices.json", help="Output market price JSON.")
    parser.add_argument("--tickers", help="Comma-separated tickers. Requires --start and --end.")
    parser.add_argument("--start", help="YYYY-MM-DD start date.")
    parser.add_argument("--end", help="YYYY-MM-DD end date.")
    parser.add_argument("--source", default="yahoo-chart", help="Source label written to output JSON.")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    ranges, existing = ranges_from_existing(input_path)

    if args.tickers:
        if not args.start or not args.end:
            parser.error("--tickers requires --start and --end")
        ranges = {ticker.strip().upper(): (args.start, args.end) for ticker in args.tickers.split(",") if ticker.strip()}

    if not ranges:
        raise SystemExit("No ticker/date ranges found. Provide --tickers, --start, and --end.")

    output = {}
    errors = {}
    for ticker, (start, end) in sorted(ranges.items()):
        try:
            output[ticker] = fetch_yahoo_daily(ticker, start, end)
            print(f"{ticker}: {len(output[ticker])} points ({output[ticker][0]['date']} to {output[ticker][-1]['date']})")
        except (HTTPError, URLError, RuntimeError, ValueError) as exc:
            errors[ticker] = str(exc)
            fallback = (existing.get("prices") or {}).get(ticker)
            if fallback:
                output[ticker] = fallback
                print(f"{ticker}: fallback {len(fallback)} points ({exc})", file=sys.stderr)
            else:
                print(f"{ticker}: failed ({exc})", file=sys.stderr)

    result = {
        "asOf": max(row[-1]["date"] for row in output.values() if row),
        "source": args.source,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "prices": output,
    }
    if errors:
        result["errors"] = errors

    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
