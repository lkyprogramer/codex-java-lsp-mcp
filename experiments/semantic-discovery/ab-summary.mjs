// input:  agent A/B 的 attempt 行（taskSuccess 只可能是 true/false/null）与
//         openaiCompatibleConfig() 结果。
// output: 每臂汇总（成功 / 全部计划 attempt；条件准确率单列）与去凭据的 backend。
// pos:    R02 分母规则在实验驱动里的唯一实现；BLOCKED/失败 attempt 留在分母。

/** successRate = successes / every scheduled attempt of the arm. */
export function summarizeArm(runs, arm) {
  const subset = runs.filter(run => run.arm === arm);
  const measured = subset.filter(run => run.taskSuccess === true || run.taskSuccess === false);
  const successes = subset.filter(run => run.taskSuccess === true).length;
  const byKind = kind => {
    const rows = subset.filter(run => (run.kind ?? "qa") === kind);
    if (rows.length === 0) return null;
    const ok = rows.filter(run => run.taskSuccess === true).length;
    const scored = rows.filter(run => run.taskSuccess === true || run.taskSuccess === false).length;
    return { scheduled: rows.length, successes: ok, successRate: ok / rows.length, measured: scored, conditionalAccuracy: scored ? ok / scored : null };
  };
  return {
    arm,
    scheduled: subset.length,
    successes,
    successRate: subset.length ? successes / subset.length : null,
    measured: measured.length,
    conditionalAccuracy: measured.length ? successes / measured.length : null,
    unmeasured: subset.length - measured.length,
    qa: byKind("qa"),
    repair: byKind("repair")
  };
}

/** The results pack never carries credentials. */
export function redactBackend(config) {
  let baseUrlHost = null;
  try {
    baseUrlHost = config?.baseUrl ? new URL(config.baseUrl).host : null;
  } catch {
    baseUrlHost = null;
  }
  return { baseUrlHost, model: config?.model ?? null, reasoningEffort: config?.reasoningEffort ?? null };
}
