"""Unit tests: reward math, grade limits, plan validation, retry/reliability scoring."""

from __future__ import annotations

import pytest

from crew.core.reward import (
    DEFAULT_WEIGHTS,
    GRADE_LIMITS,
    compute_reward,
    efficiency_score,
    outcome_score,
    reliability_score,
)
from crew.domain.catalog import ROLE_TEMPLATES, RoleSpec
from crew.domain.enums import Effort, Grade, ModelTier, Role, Verdict


def test_outcome_score_mapping():
    assert outcome_score(Verdict.PASS) == 1.0
    assert outcome_score(Verdict.PASS_WITH_NOTES) == 0.7
    assert outcome_score(Verdict.INCONCLUSIVE) == 0.0
    assert outcome_score(Verdict.FAIL) == -1.0


def test_reward_is_monotonic_in_verdict():
    good, _ = compute_reward(verdict=Verdict.PASS, quality=0.9)
    notes, _ = compute_reward(verdict=Verdict.PASS_WITH_NOTES, quality=0.9)
    bad, _ = compute_reward(verdict=Verdict.FAIL, quality=0.9)
    assert good > notes > bad


def test_reward_penalties_are_applied_and_bounded():
    clean, comps = compute_reward(verdict=Verdict.PASS, quality=1.0)
    dirty, comps2 = compute_reward(verdict=Verdict.PASS, quality=1.0,
                                   penalties=["integrity_violation", "policy_violation"])
    assert dirty < clean
    assert comps2["penalty_sum"] == pytest.approx(-1.5)
    assert -1.0 <= dirty <= 1.0


def test_efficiency_and_reliability_shapes():
    assert efficiency_score(1000, 1000, 3, 3) == 1.0
    assert efficiency_score(1000, 10_000, 3, 30) < 0.7
    assert efficiency_score(0, 5000, 3, 3) == 1.0          # no estimate → no penalty
    assert reliability_score(0, 0.0) == 1.0
    assert reliability_score(2, 0.5) < 0.7


def test_weights_override_changes_result():
    base, _ = compute_reward(verdict=Verdict.PASS_WITH_NOTES, quality=0.2)
    outcome_heavy, _ = compute_reward(verdict=Verdict.PASS_WITH_NOTES, quality=0.2,
                                      weights={"outcome": 0.9, "quality": 0.02,
                                               "efficiency": 0.04, "reliability": 0.04})
    assert outcome_heavy > base
    assert set(DEFAULT_WEIGHTS) == {"outcome", "quality", "efficiency", "reliability"}


def test_grade_limits_are_ordered_and_sane():
    tiers = [GRADE_LIMITS[g]["spend_run_usd"] for g in Grade]
    assert tiers == sorted(tiers), "spend limits must grow with grade"
    assert GRADE_LIMITS[Grade.TRAINEE]["tier"] == ModelTier.FAST
    assert GRADE_LIMITS[Grade.CHIEF]["tier"] == ModelTier.REASONING
    assert GRADE_LIMITS[Grade.TRAINEE]["autonomy"].value == "supervised"
    assert GRADE_LIMITS[Grade.PRINCIPAL]["autonomy"].value == "autonomous"


def test_role_templates_are_complete():
    assert set(ROLE_TEMPLATES) == set(Role)
    for role, template in ROLE_TEMPLATES.items():
        spec = RoleSpec.from_template(role)
        assert spec.grade <= Grade.CHIEF
        assert spec.mission, f"{role} needs a mission"
        assert template.method, f"{role} needs an operating procedure"
    assert ROLE_TEMPLATES[Role.ORCHESTRATOR].base_grade == Grade.PRINCIPAL
    assert ROLE_TEMPLATES[Role.DECIDER].base_grade >= Grade.PRINCIPAL


def test_effort_weight_grows():
    assert Effort.S.weight < Effort.M.weight < Effort.L.weight < Effort.XL.weight


def test_heuristic_plan_is_valid_dag_with_criteria():
    from crew.control.org import _has_cycle, plan_heuristic

    for goal in ["write a technical article about vector databases",
                 "build a python CLI that converts CSV to parquet",
                 "analyse our pricing data and recommend a monetisation change"]:
        plan = plan_heuristic(goal)
        assert 2 <= len(plan.tasks) <= 8
        keys = {t.key for t in plan.tasks}
        for t in plan.tasks:
            assert t.acceptance_criteria, "every task needs acceptance criteria to be verifiable"
            assert set(t.depends_on) <= keys
            assert t.effort in {e.value for e in Effort}
        assert not _has_cycle({t.key: t.depends_on for t in plan.tasks})


def test_cycle_detection():
    from crew.control.org import _has_cycle

    assert _has_cycle({"a": ["b"], "b": ["a"]})
    assert not _has_cycle({"a": [], "b": ["a"], "c": ["a", "b"]})
