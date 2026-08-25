#!/bin/bash
# Runs every kiro-acp test with pi's bundled jiti and pi's dependency tree.
# Usage: test/run-all.sh [test-file ...]
set -u

cd "$(dirname "$0")/.." || exit 1

PI_NODE_MODULES="${PI_NODE_MODULES:-$(npm root -g)/@earendil-works/pi-coding-agent/node_modules}"
JITI="$PI_NODE_MODULES/.bin/jiti"

if [ ! -x "$JITI" ]; then
	echo "jiti not found at $JITI" >&2
	echo "Set PI_NODE_MODULES to pi-coding-agent's node_modules directory." >&2
	exit 1
fi

# Tests import pi packages (@earendil-works/pi-ai) and pi's bundled deps (marked);
# resolve both from pi's tree instead of requiring a local node_modules symlink.
export NODE_PATH="$PI_NODE_MODULES"

if [ "$#" -gt 0 ]; then
	files=("$@")
else
	files=(test/*.test.ts)
fi

failures=()
for file in "${files[@]}"; do
	printf '\n\033[1m── %s\033[0m\n' "$file"
	if ! "$JITI" "$file"; then
		failures+=("$file")
	fi
done

printf '\n'
if [ "${#failures[@]}" -gt 0 ]; then
	echo "✗ ${#failures[@]}/${#files[@]} test files failed:"
	for file in "${failures[@]}"; do echo "  - $file"; done
	exit 1
fi
echo "✓ all ${#files[@]} test files passed"
