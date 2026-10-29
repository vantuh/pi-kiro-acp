// Child process for process-tree-parent.mjs: prints its pid, then stays alive
// and swallows SIGTERM so a leak is visible as a live pid after shutdown.
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
process.stdout.write(`child ${process.pid}\n`);
