#!/bin/bash
# Runs every kiro-acp test with pi's dependency tree.
# Usage: test/run-all.sh [test-file ...]
set -u

cd "$(dirname "$0")/.." || exit 1

PI_NODE_MODULES="${PI_NODE_MODULES:-$(npm root -g)/@earendil-works/pi-coding-agent/node_modules}"
export PI_NODE_MODULES

if [ ! -f "$PI_NODE_MODULES/jiti/lib/jiti.mjs" ]; then
	echo "jiti not found in $PI_NODE_MODULES" >&2
	echo "Set PI_NODE_MODULES to pi-coding-agent's node_modules directory." >&2
	exit 1
fi

if [ "$#" -gt 0 ]; then
	files=("$@")
else
	files=(test/*.test.ts)
fi

failures=()
for file in "${files[@]}"; do
	printf '\n\033[1m── %s\033[0m\n' "$file"
	if ! node test/run-test.mjs "$file"; then
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
