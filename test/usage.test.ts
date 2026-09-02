// Test: parsing of `kiro-cli chat --no-interactive /usage` output.
// Run: test/run-all.sh test/usage.test.ts

import { parseKiroUsage } from "../usage.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

// Sample captured from kiro-cli (2026-09), ANSI escapes preserved.
const SAMPLE =
  "\x1b[1mEstimated Usage\x1b[0m | resets on 2026-10-01 | \x1b[38;5;141mKIRO PRO MAX\x1b[0m\n" +
  "\x1b[1mCredits\x1b[0m (212.99 of 5000 covered in plan)\n" +
  "\x1b[38;5;141m████░░░░░░\x1b[0m 4%\n" +
  "\nSince your account is through your organization, for account management please contact your account administrator.\n";

const usage = parseKiroUsage(SAMPLE);
assert(usage !== null, "parses sample output");
assert(usage!.plan === "KIRO PRO MAX", `plan: ${usage!.plan}`);
assert(usage!.resetDate === "2026-10-01", `resetDate: ${usage!.resetDate}`);
assert(usage!.percent === 4, `percent: ${usage!.percent}`);
assert(
  usage!.credits === "212.99 of 5000 covered in plan",
  `credits: ${usage!.credits}`,
);

const noHeader = parseKiroUsage("some unrelated output");
assert(noHeader === null, "returns null without header");

const noBar = parseKiroUsage(
  "Estimated Usage | resets on 2026-10-01 | KIRO PRO MAX\nCredits (0 of 5000 covered in plan)",
);
assert(noBar !== null && noBar.percent === 0, "defaults percent to 0");
