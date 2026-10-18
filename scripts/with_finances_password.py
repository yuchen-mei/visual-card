#!/usr/bin/env python3
"""Interactive local secret handoff; no persistence, command-line secret, or log."""
import argparse
import getpass
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["inspect", "validate", "publish"])
    parser.add_argument("--input", help="Private Finances JSON outside the checkout")
    parser.add_argument("--policy", help="Reviewed private account scope and historical reference outside the checkout")
    args = parser.parse_args()
    if args.mode != "inspect" and (not args.input or not args.policy):
        parser.error("validate and publish require --input and --policy")
    if not sys.stdin.isatty():
        raise RuntimeError("INTERACTIVE_TERMINAL_REQUIRED")
    password = getpass.getpass("Existing visual-card unlock password (hidden): ").encode("utf-8")
    if not 0 < len(password) <= 4096:
        raise RuntimeError("INVALID_PASSWORD_LENGTH")
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, password)
        os.close(write_fd)
        write_fd = None
        env = os.environ.copy()
        env["VISUAL_CARD_PASSWORD_FD"] = str(read_fd)
        script = Path(__file__).with_name("update_finances.cjs" if args.mode == "inspect" else "run_finances_update.cjs")
        command = ["node", str(script)]
        command += ["--inspect"] if args.mode == "inspect" else ["--input", args.input, "--policy", args.policy]
        if args.mode == "publish":
            command.append("--publish")
        return subprocess.run(command, env=env, pass_fds=(read_fd,), check=False).returncode
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
        del password


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (EOFError, KeyboardInterrupt):
        print("PASSWORD_INPUT_CANCELLED", file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("SECURE_HANDOFF_FAILED", file=sys.stderr)
        sys.exit(1)
