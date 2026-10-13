# Crew UI/UX and game experience review

Reviewed and improved: 13 October 2026. Starting point: commit `73b6797`. Product target: a playable control room where real agents operate a company against concrete project goals through a real harness.

## Assessment

The office artwork, stable character identities, departments and company headquarters give Crew a distinctive visual foundation. The main maturity problem was the connection between that world and the actual work: historical failures appeared current, completion was poorly explained, results mixed old attempts, and several controls behaved differently from their labels. These defects have been repaired in this pass.

The revised journey is: **Home → company/project → Office to observe → Overview to plan/control → Tasks to inspect execution → Deliverables to review actual files.** Specialist team, board, memory, scores, event and settings views remain available through More views. The game presents recorded activity; it does not establish that an agent is useful, safe or independently running a successful business.

This is a locally verified improvement, not a claim that the product has completed usability research or universal device certification. Broad release gates remain in [the implementation tracker](../2026-10-10/IMPLEMENTATION.md).

## Findings and implemented fixes

| Area | Problem found | Result |
|---|---|---|
| Walking poses | A destination marked seated could make a travelling agent slide in a sitting pose. | Real movement takes precedence; seating is updated from actual arrival, including HQ board seats. |
| Facing | The direction used world x rather than horizontal movement on the isometric screen. | Characters face the direction of projected travel; screen-vertical travel keeps their facing. |
| Walking routes | SVG opacity attributes lost to a CSS rule, leaving walking routes invisible. | The animation writes inline opacity; the browser confirmed a moving route was visible. |
| Animation clock | Static atlas cells were rewritten every frame, with separate cell maps per character; hidden mounts depended on future frames. | Shared display-aligned clock targets 60 Hz in Animated mode, pauses while hidden, paints an initial state, shares the atlas lookup and avoids unchanged sprite writes. One drawing failure does not halt every character. |
| Motion preference | System reduced motion could silently suppress walking while the UI appeared to imply normal animation. | Explicit System, Animated and Calm choices. System is the default; a user can deliberately opt into animation. Calm still updates work/status. Decorative floor effects honor the selected mode. |
| HQ camera | Record refreshes could refit a camera after a user moved it. | Camera survives ordinary refreshes; resizing or explicit Fit handles refitting. Both a component regression and a browser refresh check passed. |
| HQ layering | People were drawn after furniture regardless of where they stood. | People, desks and the board table share position-based depth ordering. |
| Floor controls | Room chips and three size chips crowded the toolbar; fixed-width controls were stretched by the shared field component. | Compact selectors, a room zoom selector, an agent selector and corrected shared field widths. Short windows can scroll rather than lose the floor entirely. |
| Zoom | Zoom out could enlarge a floor fitted below the manual minimum. | Lower zoom range and outward-gesture guard; fitted floors do not jump inward. |
| Agent inspection | At overview zoom, characters and names were small; a 380 px sidebar could consume a phone screen. | Selecting an agent zooms to an inspectable scale. Narrow screens use a bounded, dismissible dialog; keyboard users can inspect every agent through a labelled selector. |
| Room growth | A polling refresh could cancel the timer that removed a new-room highlight. | Highlights expire against recorded appearance times instead of a polling-cancelled timeout. Removed agents' motion/idle records are cleaned up. |
| Current activity | Older blocked/failed tasks could override a later successful run. | The API exposes the authoritative latest run ID; the office derives current activity from active work, while historical work remains accessible. The real completed project now shows zero working/thinking agents and no stale attention count. |
| Completion and pause | A completed project still offered Pause; failed/stopped states were unclear; budget pauses were not consistently recognized for Resume. | Explicit run labels and outcome guidance. Completed runs link to deliverables; failed/stopped runs link to task review; budget pauses link to spending settings and offer Resume. |
| Run creation | An active run could lead to a Start anyway flow even though the backend refuses a second run. | Start is disabled for an active run. Guided/Autonomous descriptions retain tool approvals and spending caps; autonomous no longer implies bypassing those controls. |
| Navigation | Eleven equal project tabs obscured the primary workflow, and returning Home required closing projects. | Four primary project views plus More views. Home preserves open projects and their filters; reopening a project restores its view. Background events still badge projects while Home is visible. |
| Keyboard access | Tabs lacked arrow navigation; the project switcher did not move focus through items or return it on Escape. | Roving tab focus with arrows/Home/End, switcher item navigation that skips disabled items, Escape focus restoration, named panels and visible focus outlines. HQ adds keyboard pan/zoom/Fit. |
| Demo onboarding | Provider setup could interrupt a keyless Demo experience. | Demo no longer opens the provider prompt automatically or requires a provider in its getting-started checklist. Live remains an explicit choice after configuration. The simulated developer scenario is labelled and its welcome screen does not invite real credentials. |
| Task contract | The client sent abbreviated query names, so Latest run and several other filters did not reach the API correctly. | Canonical REST query names for run, department, squad and agent. Browser verified one latest-run task and 32 historical tasks through All runs. |
| Task evidence | The table expected integer cost and verification fields that the list response did not expose; inconclusive verdicts could inherit success coloring. | Exact stored cost units and latest verification are returned in a batch. The table shows estimated cost, a real pass/fail/inconclusive distinction, and a proper filter-empty state. |
| Result versions | Multiple retries produced duplicate filenames; downloads could include files hidden by the UI filter. | Latest run and latest file views are the default; All runs/All versions expose history. ZIP requests name exactly the visible artifact IDs, with scope checks and byte-level API regression coverage. |
| Workstation history | An agent's historical failure could be labelled its current task inside inspection. | The workstation's task/output follows the latest run. Agents without a task in that run get an explicit explanation and a route to earlier deliverables. Activity remains a timestamped event history. |
| Recovery from UI errors | A failed project detail request could leave body skeletons indefinitely; missing task status could look like idle work. | Retryable project/task-status errors instead of silent loading or a misleading empty state. Long goals can be expanded and edited in a multi-line field. |

## Verification

- **Frontend: 322 tests passed in 45 files.** Added coverage includes animation lifecycle/preferences, walking poses and direction, camera preservation, tab/menu keyboard behavior, Home persistence/badges, Demo checklist behavior, current-work scope, file versions, task query names and budget-paused controls.
- **Backend: 298 tests passed, one host-dependent symlink case skipped, one paid-provider case excluded.** Backend lint passed after repairing a test formatting issue. Run identity, selected-file ZIP content and task cost/latest-verification contract are covered.
- **Production frontend and both Docker images built successfully.** The revised local app was deployed with its existing volumes and provider configuration preserved. The main production JS bundle is approximately 372 KB / 115 KB gzip. The shared deliverable preview still prevents that panel from having an independent lazy chunk.
- **Final release checks:** whitespace validation passed; the candidate-file secret scan covered 359 files and found no leaks. Deployed backend image: `sha256:ae5567f8dc384bc26603bf0b1c2c9fdf359e6677d8f7c90c5f5a345875fc50f0`; frontend image: `sha256:ddaf972f991c79f941fc330e14a0daa2984c00f1311df867f478f972a3ec1b5f`.
- **Browser game checks:** explicitly selected Animated mode showed five walking characters; successive DOM observations confirmed movement. A route with computed opacity zero was found and repaired; a later check confirmed visible moving routes. Calm mode retained status updates. Room focus produced a legible close view; HQ zoom survived an ordinary data refresh.
- **Narrow-screen check:** 390 × 844 viewport. Agent dialog bounds and workstation content fit inside the viewport, with no document horizontal overflow. Escape dismissed it; the viewport override was reset afterward. This is a browser viewport check, not a physical phone test.
- **Actual application checks:** the prior DeepSeek project remains completed. Office status is clear; latest task count is one, estimated task usage is displayed, and the verification verdict is pass. All runs shows 32 historical tasks; latest deliverables shows the four final files.
- **No additional provider usage:** both company/project ledgers still reconcile at US$3.626132, with zero held usage. This UI pass used the credential-free scenario for staged activity and the existing real result for state/evidence checks; it did not run another paid project.

Existing authentication tests emit React `act` warnings; CrewAI emits callback/deprecation warnings. They were not hidden. Functional tests passed, but the warnings and the shared chunk limitation remain engineering cleanup items.

## Screenshots

The game and phone screenshots use the explicitly labelled simulated Northwind scenario. The result and task screenshots use the actual, previously completed DeepSeek temperature-converter project; the app's current Demo setting does not rewrite its historical Live result.

- [Room detail](assets/office-detail.png)
- [Phone-sized agent inspection](assets/mobile-agent.png)
- [Headquarters](assets/headquarters.png)
- [Actual completed deliverables](assets/completed-deliverables.png)
- [Actual current-run task](assets/current-run-task.png)

## What still needs evidence before claiming a mature broad release

1. Observe a small pilot completing the whole first-project journey without private assistance. Measure time to first result, whether users understand Demo/Live and costs, whether they find stop/approval controls, and whether they can locate the verified files. Fix observed blockers before promotion.
2. Run NVDA/VoiceOver and physical touch-device checks, including zoomed text, short landscape screens and motor-accessibility workflows. Keyboard/dialog regressions and one viewport do not establish full accessibility compliance.
3. Profile the office on representative hardware at the maximum advertised company size, while hiring, meeting, receiving events and switching tabs. A 60 Hz target and successful movement checks are not a measured universal 60 fps guarantee.
4. Observe browser/platform CI and complete fresh installations on each advertised provider/OS. Expand response-contract coverage so field/query mismatches are caught automatically rather than only in the browser.
5. Keep the existing Chroma advisories, binary notice work and broader runtime stress/release gates open. UI polish does not clear those technical findings. See [dependency assessment](../../DEPENDENCIES.md) and [support matrix](../../SUPPORT-MATRIX.md).

Recommended release positioning remains a supervised, local-first experimental agent-company control room. The result is substantially clearer and more reliable; successful autonomous business operation and a viral launch still require evidence beyond this UI pass.
