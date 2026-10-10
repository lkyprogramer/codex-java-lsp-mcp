// input:  Candidate regions of one arm ({path, startLine, endLine}) and one
//         gold row (required_evidence with 1-based inclusive line ranges).
// output: required_line_recall with the frozen kit scorer's semantics.
// pos:    R11 label challenge (R10 review P2): the old compare.mjs coverage()
//         gave a path-only hint whole-file credit and any overlap full credit.
/**
 * Kit scorer semantics (harness/scoring.py line_set / required_line_recall):
 * the required evidence is a set of (path, line) points and the arm's
 * prediction is the union of its ranged regions; recall = |pred ∩ req| / |req|.
 * A path-only region (no line range) contributes no lines - it is not
 * whole-file credit - and any overlap counts only the lines it covers.
 *
 * Differences from the kit, which validates a whole result (one bad region
 * makes every metric 0): here a path-only or malformed region (start > end,
 * start < 1) only contributes nothing and is counted. Region content hashes
 * and byte costs are not checked. `uniqueLines` is the size of the union;
 * the kit's `emitted_lines` sums region lengths (overlaps counted twice).
 */
const ranged = region => Number.isInteger(region?.startLine) && Number.isInteger(region?.endLine);
const wellFormed = region => ranged(region) && region.startLine >= 1 && region.startLine <= region.endLine;

function lineSet(regions) {
  const points = new Set();
  for (const region of regions ?? []) {
    if (!region?.path || !wellFormed(region)) continue;
    for (let line = region.startLine; line <= region.endLine; line += 1) points.add(`${region.path}:${line}`);
  }
  return points;
}

export function requiredLineRecall(regions, gold) {
  const required = lineSet((gold.required_evidence ?? []).map(e => ({ path: e.path, startLine: e.start_line, endLine: e.end_line })));
  const predicted = lineSet(regions);
  let hit = 0;
  for (const point of required) if (predicted.has(point)) hit += 1;
  const complete = [];
  const incomplete = [];
  for (const evidence of gold.required_evidence ?? []) {
    let all = true;
    for (let line = evidence.start_line; line <= evidence.end_line; line += 1) all &&= predicted.has(`${evidence.path}:${line}`);
    (all ? complete : incomplete).push(`${evidence.path}:${evidence.start_line}-${evidence.end_line}`);
  }
  return {
    recall: required.size ? hit / required.size : null,
    complete,
    incomplete,
    uniqueLines: predicted.size,
    pathOnlyRegions: (regions ?? []).filter(region => !ranged(region)).length,
    malformedRegions: (regions ?? []).filter(region => ranged(region) && !wellFormed(region)).length
  };
}

