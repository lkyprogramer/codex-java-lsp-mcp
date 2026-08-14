const expectedInstanceId = process.argv[2];

if (typeof expectedInstanceId !== "string" || expectedInstanceId.length === 0) {
  throw new Error("Expected a candidate instance identifier.");
}

let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  payload += chunk;
});
process.stdin.on("end", () => {
  try {
    const health = JSON.parse(payload);
    if (health.status !== "ok" || health.instanceId !== expectedInstanceId) {
      process.exitCode = 1;
    }
  } catch {
    process.exitCode = 1;
  }
});
