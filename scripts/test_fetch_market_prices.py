import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fetch_market_prices as market


def rows(*dates):
    return [{"date": date, "close": 100 + index} for index, date in enumerate(dates)]


def baseline(prices, as_of="2026-01-06"):
    return {"asOf": as_of, "source": "yahoo-chart", "generatedAt": "2026-01-06T23:00:00Z", "prices": prices}


class MarketPriceTests(unittest.TestCase):
    def test_checked_in_ranges_cover_all_retained_active_history(self):
        ranges = market.load_ranges(market.DEFAULT_CONFIG)
        existing = market.load_existing(market.DEFAULT_CONFIG.parent.parent / "market.prices.json")
        active_prices = {ticker: existing["prices"][ticker] for ticker in ranges}
        self.assertEqual(
            market.validate_prices(ranges, active_prices, existing["asOf"], existing["prices"]),
            existing["asOf"],
        )

    def test_archived_series_is_preserved_and_excluded_from_latest_date(self):
        old = baseline({"OLD": rows("2020-01-02", "2020-01-03"), "LIVE": rows("2026-01-05", "2026-01-06")})
        original = copy.deepcopy(old)
        result = market.build_result({"LIVE": "2026-01-05"}, {"LIVE": rows("2026-01-05", "2026-01-06", "2026-01-07")}, old, "2026-01-07")
        self.assertEqual(result["prices"]["OLD"], old["prices"]["OLD"])
        self.assertEqual(result["asOf"], "2026-01-07")
        self.assertEqual(old, original)
        self.assertEqual(set(result), {"asOf", "source", "generatedAt", "prices"})

    def test_new_ticker_accepts_one_real_first_day_close(self):
        result = market.build_result({"NEW": "2026-01-07"}, {"NEW": rows("2026-01-07")}, {}, "2026-01-07")
        self.assertEqual(result["prices"]["NEW"], rows("2026-01-07"))
        for invalid in ([], rows("2026-01-08")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                market.build_result({"NEW": "2026-01-07"}, {"NEW": invalid}, {}, "2026-01-07")

    def test_reopen_keeps_earliest_start_and_all_old_dates(self):
        old = baseline({"BACK": rows("2026-01-05", "2026-01-06")})
        result = market.build_result({"BACK": "2026-01-05"}, {"BACK": rows("2026-01-05", "2026-01-06", "2026-01-07")}, old, "2026-01-07")
        self.assertEqual(result["prices"]["BACK"][0]["date"], "2026-01-05")
        with self.assertRaisesRegex(ValueError, "discard existing history"):
            market.build_result({"BACK": "2026-01-07"}, {"BACK": rows("2026-01-07")}, old, "2026-01-07")
        with self.assertRaisesRegex(ValueError, "omit existing history"):
            market.build_result({"BACK": "2026-01-05"}, {"BACK": rows("2026-01-05", "2026-01-07")}, old, "2026-01-07")

    def test_active_freshness_and_latest_date_agreement_remain_required(self):
        with self.assertRaisesRegex(ValueError, "inconsistent latest dates"):
            market.build_result({"A": "2026-01-05", "B": "2026-01-05"}, {"A": rows("2026-01-05", "2026-01-06"), "B": rows("2026-01-05")}, {}, "2026-01-06")
        with self.assertRaisesRegex(ValueError, "unexpectedly stale"):
            market.build_result({"A": "2026-01-01"}, {"A": rows(*(f"2026-01-{day:02d}" for day in range(1, 9)))}, {}, "2026-01-16")

    def test_missing_new_ticker_and_sparse_history_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "ticker set"):
            market.build_result({"NEW": "2026-01-07"}, {}, {}, "2026-01-07")
        with self.assertRaisesRegex(ValueError, "sparse data"):
            market.build_result({"NEW": "2026-01-01"}, {"NEW": rows("2026-01-01", "2026-01-20")}, {}, "2026-01-20")

    def test_bad_archived_rows_are_not_silently_dropped(self):
        for invalid in ([], [{"date": "2026-01-02", "close": None}], rows("2026-01-02", "2026-01-02")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                market.build_result({"LIVE": "2026-01-07"}, {"LIVE": rows("2026-01-07")}, baseline({"OLD": invalid}), "2026-01-07")

    def test_unchanged_result_preserves_timestamp_and_archive(self):
        old = baseline({"OLD": rows("2020-01-02"), "LIVE": rows("2026-01-05", "2026-01-06")})
        result = market.build_result({"LIVE": "2026-01-05"}, {"LIVE": old["prices"]["LIVE"]}, old, "2026-01-06", generated_at="2099-01-01T00:00:00Z")
        self.assertEqual(result, old)

    def test_cli_fetches_only_active_tickers_and_keeps_string_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            config, output = Path(directory) / "ranges.json", Path(directory) / "market.json"
            config.write_text(json.dumps({"LIVE": "2026-01-07"}))
            old = baseline({"OLD": rows("2020-01-02")})
            output.write_text(json.dumps(old))
            argv = ["fetch_market_prices.py", "--config", str(config), "--output", str(output), "--end", "2026-01-07"]
            with patch("sys.argv", argv), patch.object(market, "fetch_with_retries", return_value=rows("2026-01-07")) as fetch, contextlib.redirect_stdout(io.StringIO()):
                market.main()
            fetch.assert_called_once_with("LIVE", "2026-01-07", "2026-01-07", 3)
            self.assertEqual(json.loads(output.read_text())["prices"]["OLD"], old["prices"]["OLD"])
            self.assertEqual(market.load_ranges(config), {"LIVE": "2026-01-07"})

    def test_cli_failure_or_missing_history_leaves_output_bytes_unchanged(self):
        cases = [(RuntimeError("synthetic fetch failure"), SystemExit), (rows("2026-01-05", "2026-01-07"), ValueError), ([], ValueError)]
        for fetched, error in cases:
            with self.subTest(fetched=fetched), tempfile.TemporaryDirectory() as directory:
                config, output = Path(directory) / "ranges.json", Path(directory) / "market.json"
                config.write_text(json.dumps({"LIVE": "2026-01-05"}))
                old = baseline({"LIVE": rows("2026-01-05", "2026-01-06")})
                original = (json.dumps(old, indent=2) + "\n").encode()
                output.write_bytes(original)
                argv = ["fetch_market_prices.py", "--config", str(config), "--output", str(output), "--end", "2026-01-07"]
                options = {"side_effect": fetched} if isinstance(fetched, Exception) else {"return_value": fetched}
                with patch("sys.argv", argv), patch.object(market, "fetch_with_retries", **options), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(error):
                    market.main()
                self.assertEqual(output.read_bytes(), original)
                self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ["market.json", "ranges.json"])

    def test_malformed_existing_output_is_not_treated_as_empty_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.json"
            path.write_text("{broken")
            with self.assertRaises(json.JSONDecodeError):
                market.load_existing(path)
            self.assertEqual(path.read_text(), "{broken")


if __name__ == "__main__":
    unittest.main()
