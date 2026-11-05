# Independent review

Reviewer: integrity_independent_review (read-only independent agent). Review recorded 2026-10-11.
Candidate base: 04058e43b8b2658864d0de09c8d6024e9928dfc5.
Scope: index integrity/recovery, Java dispatch and local class graph identity, JDT process/lease lifecycle, K contract verification scripts.

All concrete findings are closed. The reviewer independently reproduced and rechecked Parent self-call dispatch (add override EXACT to VIRTUAL; delete back to EXACT) and two same-named local classes/methods retaining distinct graph mappings.

Other closed findings inspected against source and raw RED/GREEN: live-child lease/heartbeat/reservation retention; two-pass reconcile reference/edge building; resolved parameter type identity; complete XML reconciliation; K05 non-vacuous deletion oracle; K17 actual broad query with separately labeled same-DB SQL physical-work measurements.

K05 final raw: three declarations and one actual edge before deletion; declarations, owned edges and old endpoint references absent afterward, sibling retained. K17 final raw: postings 25, examined 29; bounded postings 2 and explicit postings stop reason. Real MCP suite: 7/7.

Implementer logs read by reviewer: INDEX 23/23, dispatch 34/34, JDT 153/153 and late-exit 3/3, local identity 48/48. These counts were not independently rerun wholesale. No remaining concrete finding in reviewed scope.

Limits: code/evidence review is not release qualification. Final full validation, actual JDT, K29, model evaluation and HTTP smoke must be bound to measured candidate evidence. No claim of improved agent success, installation, deployment or production cache repair. The root later corrected a case-sensitive assertion in the JDT acceptance driver to match the actual --enable-lsp hint; production code is unchanged by that correction and real JDT is rerun.
