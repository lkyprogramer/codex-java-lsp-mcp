// An owned grandchild that requires group-wide escalation during teardown.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
