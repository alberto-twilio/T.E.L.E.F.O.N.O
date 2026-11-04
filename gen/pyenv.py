"""Which Python is this, and can it see Playwright? Debug output only.

stdlib-only on purpose: it must work (and say something useful) in exactly the
situation it exists for, an interpreter where `import playwright` fails. It is
NOT part of gen/core.py, so it never ends up in a standalone script.
"""
import sys
import shutil
import subprocess
import importlib.util


def _playwright():
    """Where Playwright is found for THIS interpreter, without trusting a bare import."""
    info = {"found": False, "path": None, "version": None, "error": None}
    try:
        spec = importlib.util.find_spec("playwright")
    except Exception as e:  # noqa: BLE001, find_spec can raise on a broken path entry
        info["error"] = f"find_spec failed: {e!r}"
        return info
    if spec is None:
        info["error"] = "no module named 'playwright' on sys.path"
        return info
    info["found"] = True
    locations = list(spec.submodule_search_locations or [])
    info["path"] = locations[0] if locations else spec.origin
    try:
        from importlib import metadata
        info["version"] = metadata.version("playwright")
    except Exception as e:  # noqa: BLE001
        info["version"] = f"unknown ({e.__class__.__name__})"
    return info


def _pip_version(cmd):
    """First line of `<cmd> --version`, e.g. 'pip 24.0 from /x/site-packages/pip (python 3.9)'."""
    try:
        out = subprocess.run(cmd + ["--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             universal_newlines=True, timeout=15)
        text = (out.stdout or "").strip().splitlines()
        return text[0] if text else f"no output (exit {out.returncode})"
    except Exception as e:  # noqa: BLE001, a missing/hanging pip must not break the report
        return f"failed: {e.__class__.__name__}: {e}"


def _pip():
    """`pip3` as found on PATH (what a user types) next to `python -m pip` (what this interpreter owns).
    When they point at different Pythons, `pip3 install` lands somewhere this run can't see."""
    pip3_path = shutil.which("pip3")
    return {
        "pip3_path": pip3_path,
        "pip3_version": _pip_version([pip3_path]) if pip3_path else None,
        "module_version": _pip_version([sys.executable, "-m", "pip"]),
    }


def report():
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    return {
        "executable": sys.executable,
        "version": sys.version.split()[0],
        "prefix": sys.prefix,
        "virtualenv": in_venv,
        "playwright": _playwright(),
        "pip": _pip(),
        "sys_path": list(sys.path),
    }


def debug_lines(prefix="[debug]"):
    """The report as plain lines, safe to print into a run log (no secrets in here)."""
    r = report()
    pw = r["playwright"]
    lines = [
        f"{prefix} python executable: {r['executable']}",
        f"{prefix} python version: {r['version']}  (prefix {r['prefix']}, virtualenv: {'yes' if r['virtualenv'] else 'no'})",
    ]
    if pw["found"]:
        lines.append(f"{prefix} playwright: {pw['version']} at {pw['path']}")
    else:
        lines.append(f"{prefix} playwright: NOT FOUND for this Python ({pw['error']})")
        lines.append(f"{prefix} install it for this exact interpreter: {r['executable']} -m pip install playwright")
    pip = r["pip"]
    if pip["pip3_path"]:
        lines.append(f"{prefix} pip3 on PATH: {pip['pip3_path']}")
        lines.append(f"{prefix} pip3 version: {pip['pip3_version']}")
    else:
        lines.append(f"{prefix} pip3 on PATH: NOT FOUND")
    lines.append(f"{prefix} python -m pip: {pip['module_version']}")
    lines.append(f"{prefix} sys.path: {r['sys_path']}")
    return lines
