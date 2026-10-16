"""Guards from the 16 October verification run: the audit task burned three attempts and its
whole step budget reading the product tree, wrote no file, and every dependent task hung on it.
Two causes, one task shape: too few steps for a repo-scale audit, and no instruction to write
the deliverable before the research is finished.
"""

from __future__ import annotations


def test_a_deliverable_task_is_told_to_write_the_file_before_it_keeps_researching():
    from crew.execution.prompt import build_task_prompt

    with_file = build_task_prompt(title="Audit the product source", description="read it",
                                  deliverable="product_evidence_map.md",
                                  acceptance_criteria=["File exists at the workspace root."])
    assert "WORK ORDER" in with_file
    assert "BEFORE you keep researching" in with_file
    assert "fails its acceptance criteria" in with_file

    no_file = build_task_prompt(title="Answer a question", description="say it",
                                deliverable="", acceptance_criteria=["Answered."])
    assert "WORK ORDER" not in no_file


def test_a_repo_scale_audit_gets_more_steps_than_a_short_writer():
    from crew.execution.runner import steps_budget

    assert steps_budget("S") < steps_budget("M") < steps_budget("L") < steps_budget("XL")
    # Ten steps was the old L budget, and it went entirely on listing and grepping.
    assert steps_budget("L") >= 16
    assert steps_budget("XL") >= 20
    assert steps_budget("nonsense") == steps_budget("M")
