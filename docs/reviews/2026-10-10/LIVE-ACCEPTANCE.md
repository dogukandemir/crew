# Real-provider acceptance record

Verified 13 October 2026 in the isolated local Compose installation, with the maintainer's configured DeepSeek provider and aggregate US$5 authorization. The original native Demo installation was not used for paid testing.

## Result

**Passed for the bounded temperature-converter project.** Real agents produced executable Python, tests and documentation. The repaired completion workflow executed the exact approved test command, published all four deliverables, passed the evaluator's full rubric and settled its usage ledger.

| Evidence | Observed result |
|---|---|
| Generated test suite | 10 tests, exit code 0, `OK`, executed inside the private Docker sandbox |
| Independent behavioral checks | 12 formula cases and 10 invalid-input cases passed |
| Downloaded public example | 10 tests independently reproduced on Windows/Python 3.12 |
| Artifact integrity | All four downloaded files matched the recorded SHA-256 values |
| Final completion run | `790d1496ec9346b7ac0c0a25deb2dda2`, `completed`, `DONE` |
| Final task | One task, one execution attempt; scoped approval waiting did not count as failure |
| Evaluator | Every criterion passed; recorded quality 1.00 |
| Aggregate estimated usage | US$3.626132 across all attempts; US$5 cap |
| Held usage after completion | Zero |
| Company/project ledger reconciliation | Both passed |

The actual files, unedited captured command output and manifest are available in [the verified example](../../../examples/temperature-converter/PROVENANCE.md). The application's worker-only run cost differs from total project usage, which also includes planning, staffing and evaluation. The aggregate figure above includes those calls and failed attempts.

## Intervention and limitations

The series included eight unsuccessful or partial attempts before the final completion run. Earlier runs exposed defects in SDK model identity, planner formatting, bounded reasoning output, CrewAI prompt templates, stop-marker forwarding, artifact publication, approval continuation and evaluator evidence. The final run reused previously generated source files after those integration fixes. This record does not claim clean first-run success from the original checkout.

Operator approval was limited to inspected code invoking `python -m unittest test_converter.py` in the restricted sandbox. A batch approval was rejected by automatic review; individual inspected requests were subsequently approved. No standing permission was granted. Network tools, package installation, destructive filesystem tools and outbound Git publication were excluded from the acceptance goal/policy.

Engineering's subordinate envelope was increased from US$1.50 to US$2.50 after it held further calls. The cumulative company/project limits remained US$5, and all existing spend was retained. The saved provider credential remained encrypted in the local vault.

Full stopped-installation backup/restore separately recovered a Demo database, workspace file and decryptable vault entry into fresh volumes. The Live installation and its real credential were not used as the recovery fixture.

Remaining gates are listed in [IMPLEMENTATION.md](IMPLEMENTATION.md): dependency advisories, wider concurrency/contract review, exact-build binary notices, remote CI, support-matrix testing, an authentic recording and pilot feedback. This single coding example is not proof of autonomous business operation or general safety.
