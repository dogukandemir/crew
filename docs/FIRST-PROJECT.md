# Your first real agent project

First explore Demo to learn the office, tasks, event history and deliverables. Its output is simulated and its model cost is zero.

For a small Live exercise, configure a provider, explicitly enable Live, and create a company with a modest cap you are willing to spend. Set a smaller project cap within it. Use provider-side billing limits too: Crew records estimated usage and cannot undo an already-sent request.

Use this goal:

> Create a small, self-contained Python project that converts temperatures between Celsius and Fahrenheit. Write converter.py, test_converter.py using only unittest, and README.md with usage instructions. Test freezing and boiling points, negative values, and invalid input. Run the tests. Report the actual output and any failures. Do not install packages or use the network.

Review the plan and start the run explicitly. Approve tools only after checking their exact command and project. Follow the tasks and event log while the office animates.

Accept the result only after checking:

- The Deliverables view opens actual files with the expected content.
- A tool result shows that tests actually ran, including their output and exit status. A model saying “tests passed” is insufficient.
- You can run `python -m unittest test_converter.py` independently in a disposable environment and obtain the expected result.
- Failures and missing files remain visible. Review the verification notes and recorded usage.

If the run fails, keep its evidence and inspect the error before retrying. Stopping blocks further work but an in-flight provider request may still bill. The [13 October acceptance record](reviews/2026-10-10/LIVE-ACCEPTANCE.md) and [downloadable verified example](../examples/temperature-converter/PROVENANCE.md) document a completed DeepSeek workflow, including earlier failures and the required repairs/approval. They establish one supervised coding result, not a general reliability benchmark.

For a public demo, show the goal, an actual tool invocation, the resulting file and independent test output in the same recording. Label Demo recordings clearly, redact secrets and disclose the model and estimated cost. The product promise is a visible, supervised agent company; avoid claims of guaranteed income or fully autonomous business success.
