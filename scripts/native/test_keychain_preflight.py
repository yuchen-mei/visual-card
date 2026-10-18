#!/usr/bin/env python3
"""Build/test a no-secret native probe; never create or query Keychain items."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

SOURCE = Path(__file__).with_name("keychain_preflight.c")


def run(args, *, env=None):
    return subprocess.run(args, capture_output=True, text=True, env=env, check=False)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def main():
    with tempfile.TemporaryDirectory(prefix="visual-card-native-preflight-") as directory:
        binary = str(Path(directory) / "preflight")
        compiled = run(["/usr/bin/xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", str(SOURCE), "-framework", "Security", "-framework", "CoreFoundation", "-o", binary])
        require(compiled.returncode == 0, "COMPILE_FAILED")
        unsigned = run([binary, "--preflight"])
        require(unsigned.returncode != 0 and not unsigned.stdout, "NON_HARDENED_ACCEPTED")
        signed = run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", "local.visual-card.keychain-preflight", binary])
        require(signed.returncode == 0, "SIGN_FAILED")
        verified = run(["/usr/bin/codesign", "--verify", "--strict", binary])
        require(verified.returncode == 0, "VERIFY_FAILED")
        result = run([binary, "--preflight"])
        require(result.returncode == 0 and not result.stderr, "PREFLIGHT_FAILED")
        status = json.loads(result.stdout)
        require(status["selfOnlyDecryptAclInMemory"] and status["exactAdhocIdentity"] and not status["credentialStorageEnabled"], "PREFLIGHT_STATUS")
        for args in [[], ["--enroll"], ["--read"], ["--preflight", "--output-fd", "1"], ["--preflight", "arbitrary.js"]]:
            rejected = run([binary, *args])
            require(rejected.returncode != 0 and rejected.stdout == "" and rejected.stderr == "E_PREFLIGHT_ONLY\n", "UNSAFE_MODE_ACCEPTED")
        poisoned = os.environ.copy()
        poisoned.update({"NODE_OPTIONS": "--eval=throw new Error('untrusted')", "PYTHONPATH": directory, "VISUAL_CARD_PASSWORD_FD": "1"})
        result = run([binary, "--preflight"], env=poisoned)
        require(result.returncode == 0 and json.loads(result.stdout) == status and not result.stderr, "ENVIRONMENT_AFFECTED_PROBE")
        dynamic = run(["/usr/bin/nm", "-u", binary])
        require(dynamic.returncode == 0, "SYMBOL_AUDIT_FAILED")
        forbidden = ["_SecItem", "_SecKeychainItem", "_SecKeychainFind", "_SecKeychainAdd", "_posix_spawn", "_exec", "_system", "_popen"]
        require(not any(symbol in dynamic.stdout for symbol in forbidden), "FORBIDDEN_API_LINKED")
        print(json.dumps({"status": "passed", "checks": 10, "keychainItemsAccessed": False, "credentialStorageEnabled": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("NATIVE_PREFLIGHT_TEST_FAILED")
