#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$root/vendor/glib" "$tmp/glib"
export CARGO_TARGET_DIR="$tmp/target"
test_name=variant_iter::tests::test_variant_iter_array
cargo generate-lockfile --manifest-path "$tmp/glib/Cargo.toml"
if [ -n "${GLIB_REGRESSION_LOCKFILE:-}" ]; then
    cp "$tmp/glib/Cargo.lock" "$GLIB_REGRESSION_LOCKFILE"
fi
cargo test --locked --manifest-path "$tmp/glib/Cargo.toml" --release --lib "$test_name" -- --exact 2>&1 | tee "$tmp/fixed.log"
grep -Fxq 'running 1 test' "$tmp/fixed.log"
grep -Fxq "test $test_name ... ok" "$tmp/fixed.log"
python3 - "$tmp/glib/src/variant_iter.rs" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
for fixed, original in [
    ('let mut p: *mut libc::c_char = std::ptr::null_mut();', 'let p: *mut libc::c_char = std::ptr::null_mut();'),
    ('                &mut p,', '                &p,'),
]:
    assert s.count(fixed) == 1
    s = s.replace(fixed, original)
p.write_text(s)
PY
cargo test --locked --manifest-path "$tmp/glib/Cargo.toml" --release --lib "$test_name" --no-run
set +e
cargo test --locked --manifest-path "$tmp/glib/Cargo.toml" --release --lib "$test_name" -- --exact 2>&1 | tee "$tmp/mutant.log"
status=${PIPESTATUS[0]}
set -e
failed_test=false
if grep -Fxq "test $test_name ... FAILED" "$tmp/mutant.log" ||
    { grep -Fq "'$test_name' --exact" "$tmp/mutant.log" &&
        grep -Fq '(signal: 11, SIGSEGV:' "$tmp/mutant.log"; }; then
    failed_test=true
fi
if [ "$status" -ne 101 ] ||
    ! grep -Fxq 'running 1 test' "$tmp/mutant.log" ||
    ! grep -Fq 'error: test failed' "$tmp/mutant.log" ||
    [ "$failed_test" != true ]; then
    echo 'ERROR: reversed backport did not produce the expected test failure' >&2
    exit 1
fi
echo 'Backport regression passed; reversed backport failed.'
