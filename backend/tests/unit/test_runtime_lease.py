import pytest

from crew.core.lease import runtime_lease


def test_one_runtime_per_data_directory_and_release_after_failure(tmp_path):
    with pytest.raises(ValueError, match="crash"):
        with runtime_lease(tmp_path):
            with pytest.raises(RuntimeError, match="another Crew process"):
                with runtime_lease(tmp_path):
                    pytest.fail("a second runtime acquired the lease")
            raise ValueError("crash")
    with runtime_lease(tmp_path):
        pass
