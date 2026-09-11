# P3-G5 48h sample log

- Release: `03f5a4154081` (`releases/03f5a4154081-20260909T030914Z`)
- Process: pid 15387, `runs=1`, uptime 49.7h at 2026-09-11T04:58Z
- Sampler: 8 files in `~/Library/Logs/codex-java-lsp-mcp/samples/`
- Scheduler: `01a084569afe7e91bfd269f88075cf07` every 6h

| UTC | uptime | RSS MiB | JDT | pin WAL | ok |
|---|---:|---:|---:|---:|---|
| 2026-09-09T04:04Z | 0.8h | 76.5 | 2 | 0 | true |
| 2026-09-09T11:01Z | 7.8h | 36.8 | 0 | 0 | true |
| 2026-09-09T16:59Z | 13.7h | 26.2 | 0 | 0 | true |
| 2026-09-09T22:59Z | 19.7h | 38.9 | 0 | 0 | true |
| 2026-09-10T05:58Z | 26.7h | 172.5 | 3 | 0 | true |
| 2026-09-10T15:14Z | 36.0h | 46.3 | 0 | 0 | true |
| 2026-09-10T21:46Z | 42.5h | 30.1 | 0 | 0 | true |
| 2026-09-11T04:58Z | 49.7h | 52.4 | 0 | 0 | true |

IOD-era heap FATAL/recycle/hibernate/compact = 0. watchdog = 0. One historical `database is locked` (count never increased). Exam sqlite 46.5→47.6 MiB; other pins unchanged. 172.5 MiB RSS coincided with 3 live JDT and later dropped.

Caveat: first IOD install 2026-09-08T03:21Z was interrupted by the WAL-truncation reinstall; 48h continuous applies to this process.
