# Verified Live output

These four files were produced and published by Crew's real CrewAI harness using DeepSeek during the public-readiness acceptance work on 11–13 October 2026. They were downloaded from Crew's artifact API and checked against the recorded SHA-256 values in [artifact-manifest.json](artifact-manifest.json). The source files and captured test report are preserved without editorial changes.

Run the example independently:

```sh
cd examples/temperature-converter
python -m unittest test_converter.py -v
```

## What passed

- The generated suite executed **10 tests**, returned **exit code 0**, and reported **OK** in the restricted Linux Docker sandbox.
- Independent sandbox checks passed **12 formula cases and 10 invalid-input cases**.
- The downloaded example independently reproduced **10 passing tests** on Windows with Python 3.12.
- The agent published `converter.py`, `test_converter.py`, `README.md`, and `TEST-RESULTS.md`. Publication metadata, hashes and actual command execution receipts were supplied to the evaluator; it passed every acceptance criterion.
- Company and project ledgers reconciled, with no held reservation after completion.

## Scope and cost

The final completion run was `790d1496ec9346b7ac0c0a25deb2dda2`. Its single task completed on its first execution attempt after a scoped operator approval for the exact unittest command. Worker execution used `deepseek/deepseek-flash`; earlier debugging attempts also escalated to `deepseek/deepseek-v4-pro`.

The source files were created in preceding runs of the same project. The acceptance series included **eight unsuccessful or partial attempts before the final completion run**, and implementation fixes between attempts. This is a verified repaired workflow, not a claim that the initial checkout completed a fresh goal without intervention.

Estimated cumulative project/provider usage across the whole series was **US$3.626132**, under the maintainer's aggregate **US$5** authorization. The final completion run added approximately **US$0.032236** to that total. These are application estimates using conservative configured prices, not a provider invoice. Previous spending was retained; the company and project caps were not reset.

This example demonstrates a small supervised coding outcome. It does not establish unattended company operation, business profitability, broader provider compatibility or general agent reliability. See the [implementation report](../../docs/reviews/2026-10-10/IMPLEMENTATION.md) for remaining release gates.
