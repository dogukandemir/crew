"""Company and project workspaces (ADR 0017).

One rule: a project's workspace is a real folder, chosen (or defaulted) at founding and
never re-derived silently. Agents see exactly this folder, the fs tools jail to it and
the execution sandbox mounts it at /work and nothing else.

- Founding may pick the company's root (`company.settings.workspace_root`); the default
  is `{CREW_WORKSPACE_ROOT or ~/crew/workspace}/{company}/{project}`, per the owner's
  formula. The company segment exists only in the default case, an explicit path is
  used as-is.
- Projects under a company materialize their path once (`project.settings.workspace`)
  and every later resolver reads it from there; standalone projects keep the internal
  data-dir workspace (jailed identically).
"""

from __future__ import annotations

import re
from pathlib import Path

from crew.core.db import session_scope
from crew.core.models import Project
from crew.core.security import audit
from crew.core.settings import settings

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_folder(name: str) -> str:
    """A folder-name-safe version of a company/project name. Never empty, never traversing."""
    cleaned = _ILLEGAL.sub(" ", name or "").replace(",", " ").strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "unnamed"


def default_root() -> Path:
    return settings.default_workspace_root


def company_root(company: Project) -> Path:
    """Where a company's project folders live: its chosen root, else the default tree."""
    chosen = str((company.settings or {}).get("workspace_root") or "").strip()
    if chosen:
        return Path(chosen).expanduser().resolve()
    return default_root() / f"{sanitize_folder(company.name)}-{company.id}"


# Directories an agent workspace must never be: the sandbox mounts the workspace read-write,
# so pointing one at a system root hands every shell tool the machine (16 October finding).
_FORBIDDEN_ROOTS = ("/", "/etc", "/usr", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys",
                    "/var", "/opt", "c:/", "c:/windows", "c:/program files", "c:/program files (x86)")


def validate_company_path(raw: str) -> str:
    """Validate a wizard-supplied workspace path and create it. Refuses quietly-correct-looking
    relative paths, a chosen root must be absolute, so there is never doubt where it landed."""
    p = Path((raw or "").strip()).expanduser()
    if not p.is_absolute():
        raise ValueError("workspace path must be absolute")
    p = p.resolve()
    posix = p.as_posix().lower()
    if posix in _FORBIDDEN_ROOTS or posix.rstrip("/") in _FORBIDDEN_ROOTS:
        raise ValueError(f"workspace path must not be a system directory: {p}")
    if p == Path.home().resolve():
        raise ValueError("workspace path must not be the home directory itself")
    if settings.sandbox_url and not p.is_relative_to(settings.default_workspace_root.resolve()):
        raise ValueError("Docker workspaces must stay inside the dedicated workspace volume")
    p.mkdir(parents=True, exist_ok=True)
    return str(p)


def resolve_workspace(project: Project) -> Path:
    """Where this project's files live: its materialized choice, else the internal dir.
    Self-heals a missing folder, a run must never die on an unmade directory."""
    chosen = str((project.settings or {}).get("workspace") or "").strip()
    path = Path(chosen) if chosen else settings.workspace_dir(project.id)
    path.mkdir(parents=True, exist_ok=True)
    return path


async def allocate_project_workspace(project_id: str, *, company_id: str | None = None) -> str:
    """Materialize a project's workspace folder at birth and record it on the project.

    Company projects: `{company_root}/{project_name}` (created now, written once).
    Standalone projects: the internal data-dir path (unchanged, jailed the same way).
    Idempotent, an already-recorded path is kept, never silently re-derived.
    """
    async with session_scope() as s:
        project = await s.get(Project, project_id)
        if project is None:
            raise KeyError(project_id)
        existing = str((project.settings or {}).get("workspace") or "").strip()
        if existing:
            path = Path(existing)
        elif company_id:
            company = await s.get(Project, company_id)
            if company is None or company.kind != "company":
                raise KeyError(company_id)
            path = company_root(company) / f"{sanitize_folder(project.name)}-{project.id}"
        else:
            path = default_root() / "standalone" / project.id if settings.sandbox_url else settings.workspace_dir(project.id)
        path.mkdir(parents=True, exist_ok=True)
        if not existing:
            project.settings = {**(project.settings or {}), "workspace": str(path)}
    await audit(actor_kind="system", actor_id="", action="workspace.allocated",
                resource_kind="project", resource_id=project_id, outcome="ok", reason=str(path))
    return str(path)
