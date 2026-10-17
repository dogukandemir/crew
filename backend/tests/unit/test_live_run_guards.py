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


def test_the_owner_punctuation_rule_rides_both_prompts():
    """F1: agent-authored deliverables shipped em dashes; the rule is stated in words.

    The prompt must say it on the system prompt (every task) and on the task prompt
    (the one built separately), and neither prompt may carry the character itself.
    """
    from crew.execution.prompt import build_system_prompt, build_task_prompt

    bundle = build_system_prompt(name="Maya Carter", role="worker", grade=1,
                                 mission="ship the price sheet", autonomy="supervised")
    assert "## WORDS" in bundle.system
    assert "Never use em dashes" in bundle.system
    assert "a comma," in bundle.system and "a full stop" in bundle.system

    task = build_task_prompt(title="Price sheet", description="compare the rivals",
                             deliverable="price-sheet.md",
                             acceptance_criteria=["Three rivals compared."])
    assert "WORDS" in task and "no em dashes" in task
    assert "full stop" in task

    em_dash = "\N{EM DASH}"
    assert em_dash not in bundle.system, "the prompt teaches the rule without breaking it"
    assert em_dash not in task


def test_a_repo_scale_audit_gets_more_steps_than_a_short_writer():
    from crew.execution.runner import steps_budget

    assert steps_budget("S") < steps_budget("M") < steps_budget("L") < steps_budget("XL")
    # Ten steps was the old L budget, and it went entirely on listing and grepping.
    assert steps_budget("L") >= 16
    assert steps_budget("XL") >= 20
    assert steps_budget("nonsense") == steps_budget("M")
