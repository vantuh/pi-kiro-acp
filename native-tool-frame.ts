/**
 * Rendered block for a display-only native Kiro tool.
 *
 * Thinking content is rendered as markdown, so ASCII art built from `-` and `|`
 * gets eaten (a dashed line becomes an <hr> / setext heading underline). A fenced
 * code block is the only markdown-safe way to keep tool output preformatted.
 * `~~~~` is used so that ``` fences inside tool output cannot break out, and the
 * fence grows longer than any tilde run in the body so that cannot break out either.
 */

export function nativeToolFrame(title: string, body: string, status: string): string {
	const lines = [`🔧 ${title}`];
	const trimmed = body.trim();
	if (trimmed) lines.push(trimmed);
	if (status && status !== "completed") lines.push(`[${status}]`);
	const content = lines.join("\n");
	// A closing fence is any tilde-only line (indented up to 3 spaces) at least as
	// long as the opening one, so open with one tilde more than the longest such line.
	const longest = [...content.matchAll(/^ {0,3}(~+)[ \t]*$/gm)].reduce((max, m) => Math.max(max, m[1].length), 0);
	const fence = "~".repeat(Math.max(4, longest + 1));
	return `${fence}\n${content}\n${fence}\n`;
}
