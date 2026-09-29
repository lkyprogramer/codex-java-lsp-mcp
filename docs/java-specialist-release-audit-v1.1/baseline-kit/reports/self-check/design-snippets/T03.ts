export function anchorWindows(start: number, end: number, anchors: number[], radius = 16) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
    throw new Error("invalid method bounds");
  if (!Number.isInteger(radius) || radius<0) throw new Error("invalid radius");
  const out: Array<{startLine: number; endLine: number}> = [];
  for (const line of [...new Set(anchors)].sort((a,b)=>a-b)) {
    if (!Number.isInteger(line) || line < start || line > end) throw new Error("anchor outside method");
    const next = {startLine: Math.max(start,line-radius),endLine: Math.min(end,line+radius)};
    const prev = out[out.length-1];
    if (prev && next.startLine <= prev.endLine+1) prev.endLine=Math.max(prev.endLine,next.endLine);
    else out.push(next);
  }
  return out;
}