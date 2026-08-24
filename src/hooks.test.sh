#!/bin/sh
#
# Tests for .githooks/pre-commit.
#
# The first version of that hook piped patterns into `while`, which runs the
# loop in a subshell — `exit 1` killed the subshell and the hook exited 0. It
# blocked nothing while looking like it worked. These cases catch that class of
# bug, so run them after touching the hook.
#
#   npm run test:hooks

cd "$(dirname "$0")/.." || exit 1
HOOK=.githooks/pre-commit
pass=0
fail=0

check() {
  if [ "$1" = "$2" ]; then
    echo "  PASS  $3"
    pass=$((pass + 1))
  else
    echo "  FAIL  $3 (expected exit $2, got $1)"
    fail=$((fail + 1))
  fi
}

cleanup() {
  git restore --staged src/__hooktest*.ts .env .env.example 2>/dev/null
  rm -f src/__hooktest*.ts
  [ -f /tmp/.env.example.bak ] && cp /tmp/.env.example.bak .env.example && rm -f /tmp/.env.example.bak
  # Only ever the throwaway. CREATED_ENV is empty unless this script wrote it,
  # so an interrupted run cannot take a real .env with it.
  [ -n "$CREATED_ENV" ] && rm -f .env
  return 0
}
trap cleanup EXIT

cp .env.example /tmp/.env.example.bak 2>/dev/null

# --- must BLOCK -----------------------------------------------------------
# The fake credentials are ASSEMBLED AT RUNTIME from fragments. If the literal
# shapes appeared in this file, the hook would correctly flag this file and the
# test suite could never itself be committed. Splitting them keeps the file
# clean while the string written to disk is still a full, realistic match.
ANT="sk-""ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234567890"
AWS="AKIA""IOSFODNN7EXAMPLE"
PEM="-----BEGIN"" RSA PRIVATE KEY-----"

echo "const k = \"$ANT\";" > src/__hooktest.ts
git add src/__hooktest.ts
"$HOOK" >/dev/null 2>&1
check $? 1 "blocks an Anthropic-shaped key in a source file"
git restore --staged src/__hooktest.ts 2>/dev/null
rm -f src/__hooktest.ts

echo "$AWS" > src/__hooktest2.ts
git add src/__hooktest2.ts
"$HOOK" >/dev/null 2>&1
check $? 1 "blocks an AWS access key id"
git restore --staged src/__hooktest2.ts 2>/dev/null
rm -f src/__hooktest2.ts

echo "$PEM" > src/__hooktest3.ts
git add src/__hooktest3.ts
"$HOOK" >/dev/null 2>&1
check $? 1 "blocks a private key block"
git restore --staged src/__hooktest3.ts 2>/dev/null
rm -f src/__hooktest3.ts

# B31. This case used to be wrapped in `if [ -f .env ]`, and `.env` is
# gitignored — so it ran on a developer's machine and never in a fresh checkout.
# Six cases here, five in CI, and the one that disappeared was this one: the
# only case that tests the file holding every credential at once, staged whole.
# It reported as a pass by being absent.
#
# Make the file when there isn't one. ONLY when there isn't one — clobbering a
# real .env would destroy the single file this repo tells people to keep secrets
# in, which is a steep price for a test fixture.
CREATED_ENV=""
if [ ! -f .env ]; then
  # Deliberately innocuous. If this held a key-shaped string the hook would
  # block it via the content scan and the case would pass for the wrong reason;
  # boring content proves the *filename* rule fires on its own.
  printf 'PLACEHOLDER=not-a-secret\n' > .env
  CREATED_ENV=1
fi

git add -f .env 2>/dev/null
"$HOOK" >/dev/null 2>&1
check $? 1 "blocks a staged .env file"
git restore --staged .env 2>/dev/null
[ -n "$CREATED_ENV" ] && rm -f .env

# --- must PASS ------------------------------------------------------------
printf '# example\nANTHROPIC_API_KEY=sk-ant-...\n' > .env.example
git add .env.example
"$HOOK" >/dev/null 2>&1
check $? 0 "allows the sk-ant-... placeholder in .env.example"
git restore --staged .env.example 2>/dev/null
cp /tmp/.env.example.bak .env.example 2>/dev/null

echo 'export const harmless = "just ordinary source";' > src/__hooktest4.ts
git add src/__hooktest4.ts
"$HOOK" >/dev/null 2>&1
check $? 0 "allows ordinary source with no secrets"
git restore --staged src/__hooktest4.ts 2>/dev/null
rm -f src/__hooktest4.ts

echo ""
echo "  passed $pass, failed $fail"
[ $fail -eq 0 ] || exit 1
