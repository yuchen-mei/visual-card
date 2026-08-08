#!/usr/bin/env python3
import argparse
import json
import math
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_CONFIG = Path(__file__).with_name("market_price_ranges.json")


def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def resolve_date(value):
    if value == "today":
        return datetime.now(timezone.utc).date().isoformat()
    return parse_date(value).isoformat()


def unix_time(value):
    midnight = datetime.combine(parse_date(value), datetime.min.time(), tzinfo=timezone.utc)
    return int(midnight.timestamp())


def load_ranges(path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not payload:
        raise ValueError(f"{path} must contain a non-empty object of ticker/start-date pairs")

    ranges = {}
    for ticker, start in payload.items():
        normalized_ticker = ticker.strip().upper()
        if not normalized_ticker or normalized_ticker != ticker:
            raise ValueError(f"Invalid ticker in {path}: {ticker!r}")
        if not isinstance(start, str):
            raise ValueError(f"Start date for {ticker} must be a string")
        ranges[ticker] = parse_date(start).isoformat()
    return ranges


def fetch_yahoo_daily(ticker, start, end):
    params = urlencode({
        "period1": unix_time(start),
        "period2": unix_time(end) + 86400,
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    })
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{ticker}?{params}"
    request = Request(url, headers={
        "User-Agent": "visual-card-market-price-updater/1.0",
        "Accept": "application/json",
    })

    with urlopen(request, timeout=30) as response:
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
    return rows


def fetch_with_retries(ticker, start, end, retries):
    for attempt in range(1, retries + 1):
        try:
            return fetch_yahoo_daily(ticker, start, end)
        except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError) as exc:
            if attempt == retries:
                raise RuntimeError(f"{ticker}: {exc}") from exc
            delay = 2 ** (attempt - 1)
            print(f"{ticker}: fetch failed ({exc}); retrying in {delay}s")
            time.sleep(delay)
    raise AssertionError("unreachable")


def validate_prices(ranges, prices, end):
    if set(prices) != set(ranges):
        raise ValueError("Fetched ticker set does not match configured ticker set")

    end_date = parse_date(end)
    latest_dates = set()
    for ticker, start in ranges.items():
        rows = prices[ticker]
        minimum_rows = max(2, (end_date - parse_date(start)).days // 2)
        if len(rows) < minimum_rows:
            raise ValueError(
                f"{ticker}: only {len(rows)} rows; expected at least {minimum_rows}. "
                "Refusing to replace the complete history with sparse data."
            )

        dates = [row.get("date") for row in rows]
        if dates != sorted(dates) or len(dates) != len(set(dates)):
            raise ValueError(f"{ticker}: dates must be sorted and unique")
        if dates[0] != start:
            raise ValueError(f"{ticker}: history starts at {dates[0]}, expected {start}")

        for row in rows:
            if set(row) != {"date", "close"}:
                raise ValueError(f"{ticker}: every row must contain only date and close")
            close = row["close"]
            if isinstance(close, bool) or not isinstance(close, (int, float)):
                raise ValueError(f"{ticker} {row['date']}: close must be numeric")
            if not math.isfinite(close) or close <= 0:
                raise ValueError(f"{ticker} {row['date']}: close must be finite and positive")

        latest = parse_date(dates[-1])
        if latest > end_date:
            raise ValueError(f"{ticker}: latest date {latest} is after requested end date {end}")
        if end_date - latest > timedelta(days=7):
            raise ValueError(f"{ticker}: latest date {latest} is unexpectedly stale")
        latest_dates.add(dates[-1])

    if len(latest_dates) != 1:
        raise ValueError(f"Tickers have inconsistent latest dates: {sorted(latest_dates)}")
    return latest_dates.pop()


def load_existing(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_json_atomically(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
            temporary_path = Path(temporary_file.name)
        temporary_path.replace(path)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def main():
    parser = argparse.ArgumentParser(
        description="Fetch and validate public daily closes for market.prices.json."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="JSON object mapping every required ticker to its history start date.",
    )
    parser.add_argument("--output", type=Path, default=Path("market.prices.json"))
    parser.add_argument("--end", default="today", help="YYYY-MM-DD end date, or 'today'.")
    parser.add_argument("--source", default="yahoo-chart")
    parser.add_argument("--retries", type=int, default=3)
    args = parser.parse_args()

    if args.retries < 1:
        parser.error("--retries must be at least 1")

    end = resolve_date(args.end)
    ranges = load_ranges(args.config)
    if any(parse_date(start) > parse_date(end) for start in ranges.values()):
        parser.error("--end must not be earlier than a configured start date")

    prices = {}
    failures = []
    for ticker, start in ranges.items():
        try:
            prices[ticker] = fetch_with_retries(ticker, start, end, args.retries)
            rows = prices[ticker]
            first = rows[0]["date"] if rows else "none"
            last = rows[-1]["date"] if rows else "none"
            print(f"{ticker}: {len(rows)} points ({first} to {last})")
        except RuntimeError as exc:
            failures.append(str(exc))

    if failures:
        raise SystemExit("Market price update failed; output left unchanged:\n- " + "\n- ".join(failures))

    as_of = validate_prices(ranges, prices, end)
    existing = load_existing(args.output)
    unchanged = (
        existing.get("asOf") == as_of
        and existing.get("source") == args.source
        and existing.get("prices") == prices
    )
    generated_at = existing.get("generatedAt") if unchanged else None
    if not isinstance(generated_at, str):
        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    result = {
        "asOf": as_of,
        "source": args.source,
        "generatedAt": generated_at,
        "prices": prices,
    }
    write_json_atomically(args.output, result)
    print(f"validated and wrote {args.output}")


if __name__ == "__main__":
    main()
