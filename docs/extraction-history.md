# Extraction history

Session-mode was extracted from `flurdy/ai-tools` at `bcc5a8c31e6974b72649fd7b9b02778d6631137e`. All 18 non-merge path-scoped commits were replayed with `git format-patch -k --relative=pi/session-mode` and `git am -k`, without squashing or rewriting the source repository. Only the session-mode portion of cross-component commits was imported.

Author identity, author date and complete commit messages were compared exactly. Before package hardening, the imported root tree and the source `pi/session-mode` tree both hashed to `aea73e2399150edd0fec00546905929efe53d092`, proving all 15 tracked files and modes were preserved without additions.

| Source commit | Imported commit | Subject |
|---|---|---|
| `c65cb19533328db151f87aed4327abd8e9c3d4ae` | `ed80aff33895d9e3e3c42b6d54a661101e28c730` | feat(pi): add guarded session modes |
| `0b9dee2a0319141735fd7198761c581a01acf86a` | `75cb526f07b01d6fbca177d3614ecb0c9fbf3aae` | fix(pi): abbreviate session mode status |
| `507ed9cf8c68dcf018e1c1bb74ac27c25f1e7809` | `783f24eb6f1284e8f3fba71062271aabe3b1e3f2` | fix(pi): allow stderr discard in guarded mode |
| `c983d8b3648d1c8f1a27c30a4802adf13b211188` | `5beb66993af70d21e677b3c954b0a1db295b43bd` | fix(pi): allow safe plan-mode delegation |
| `9157025a8c7c9cb110ae09c2025b0e750d5d5a4f` | `df220b1e53ce1b605192f8c9f16c563f640813ca` | fix(pi): allow harmless output discards |
| `155f92bbc9f606d29f59b7e11835bc54e74d621d` | `295daa50930c561ba197da1d0e047e1e5a80e1ef` | fix(pi): serialize session mode transitions |
| `98bb87178e7670ddad28c7c3205536516562c188` | `7f4fe3fe83eb30d10daab19274cc062ebe74f97f` | fix(pi): publish lease metadata under lock |
| `1b1a4ba5ab5d6c5877dc52b307d01a874f8ce1a5` | `6a5061f58b707199c501132967aafb744180c600` | fix(pi): harden guarded plan mode |
| `5f6ff1d77896cb95ff8e151d3d1e93ce45ff568d` | `38c4b0ec59d181c3bfcf17189913657a372f2914` | fix(pi): contain lost lease UI failures |
| `177afbac485db7343574cea0e209ac1c8d40bc22` | `c29e6ea69d5fb2841c2f5f7b7cbdbe3f710b7061` | test(pi): cover pending mode transitions |
| `fb77bf384f0e5b66566012c18e49a118ec0909de` | `fc4b1c6099accabe98035a9b607b536aa0109fe2` | test(pi): cover lease failure cleanup |
| `cd1037c304917659d9bb65fa47c1944306a6c6b9` | `0920f1ed677d93e01c84663c74545914073ace42` | fix(pi): surface subagent discovery failures |
| `9e24a068535769d500718dfd255250a98ab8ecdd` | `f5a6e1b98275b01e7248eedf30600009f986d3c8` | feat(pi): add footer guard signals |
| `19732a72f0cb8e64c1a97ee9e2796ec0d3a3e0e9` | `78d54865b2d3eeccca3cdb13eabb8bafa59d3afe` | fix(pi): bound lease Git discovery |
| `2bef3f31e9412972a970872a31cab1d69ab1c659` | `d8d29f128aed71851b750ede603bdb95e3cbf68c` | fix(pi): validate lease holder PIDs |
| `f09012f48b61a7e237cab53cfd612d4be681f7a8` | `98b868d502f2ab111ad9a14b5f6f52ab653e1d4a` | refactor(pi): consolidate guard metadata |
| `ff0a047029e0d74572d859fa9c5fe920030f8834` | `02db785264475f2914a72b34d10b033d7e254de9` | fix: allow bounded whole-system lease scans |
| `bcc5a8c31e6974b72649fd7b9b02778d6631137e` | `5e2649960a90aef73202cb0bc60b33818ece2297` | test(pi): stabilize process integration fixtures |
