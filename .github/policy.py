#!/usr/bin/env python3
"""Supply-chain policy checked by CI (LitVM team audit ATH-05, ATH-06, ATH-13).

Fails when:
  - a workflow uses an action that is not pinned to a full commit SHA, has no explicit top-level permissions,
    grants a write permission, reads a secret, uses pull_request_target, pipes a download into a shell or
    installs tools globally;
  - a .gitmodules entry has no pinned gitlink or a non-HTTPS URL;
  - for each package directory given: a direct dependency or override is not an exact version, the install
    config does not use the official registry with lifecycle scripts off, a lockfile entry resolves outside
    the official npm registry (git dependencies must be pinned to a full commit) or carries no integrity hash.

  python3 .github/policy.py [package-dir ...]
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRIES = ("https://registry.npmjs.org/", "https://registry.yarnpkg.com/")
EXACT = re.compile(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?")
PINNED_GIT = re.compile(r"git\+https://github\.com/[\w.-]+/[\w.-]+?(\.git)?#[0-9a-f]{40}")
errors = []


def check_workflows():
    files = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
    if not files:
        errors.append(".github/workflows: no workflow")
    for f in files:
        name, text = f.relative_to(ROOT), f.read_text()
        if not re.search(r"^permissions:", text, re.M):
            errors.append(f"{name}: no top-level permissions")
        if re.search(r"^\s*[\w-]+:\s*write\b|write-all", text, re.M):
            errors.append(f"{name}: write permission")
        for ref in re.findall(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)", text, re.M):
            if not ref.startswith("./") and not re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", ref):
                errors.append(f"{name}: action not pinned to a commit: {ref}")
        for pattern, why in [
            (r"pull_request_target", "pull_request_target"),
            (r"\$\{\{\s*secrets\.", "reads a secret"),
            (r"(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b", "pipes a download into a shell"),
            (r"npm\s+(i|install)\s+(-g|--global)\b|yarn\s+global\s+add|pip3?\s+install(?![^\n]*--require-hashes)",
             "global or unpinned tool install"),
        ]:
            if re.search(pattern, text):
                errors.append(f"{name}: {why}")


def check_submodules():
    if not (ROOT / ".gitmodules").exists():
        return
    out = subprocess.run(["git", "-C", str(ROOT), "config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"],
                         capture_output=True, text=True, check=True).stdout
    entries = {}
    for line in out.splitlines():
        key, value = line.split(" ", 1)
        entries.setdefault(key.rsplit(".", 1)[0], {})[key.rsplit(".", 1)[1]] = value
    for sub in entries.values():
        if not sub.get("url", "").startswith("https://"):
            errors.append(f".gitmodules: {sub.get('path')}: URL is not HTTPS")
        staged = subprocess.run(["git", "-C", str(ROOT), "ls-files", "--stage", "--", sub.get("path", "")],
                                capture_output=True, text=True, check=True).stdout
        if not staged.startswith("160000 "):
            errors.append(f".gitmodules: {sub.get('path')}: no gitlink (submodule commit not pinned)")


def check_package(directory):
    d = ROOT / directory
    manifest = json.loads((d / "package.json").read_text())
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for dep, spec in manifest.get(section, {}).items():
            if not EXACT.fullmatch(spec) and not PINNED_GIT.fullmatch(spec):
                errors.append(f"{directory}/package.json: {dep} is not an exact version: {spec}")

    def exact_overrides(node, path):
        for key, value in node.items():
            if isinstance(value, dict):
                exact_overrides(value, f"{path}{key} > ")
            elif not EXACT.fullmatch(value):
                errors.append(f"{directory}/package.json: override {path}{key} is not exact: {value}")
    exact_overrides(manifest.get("overrides", {}), "")
    exact_overrides(manifest.get("resolutions", {}), "")

    npmrc = (d / ".npmrc").read_text() if (d / ".npmrc").exists() else ""
    if "registry=https://registry.npmjs.org/" not in npmrc or "ignore-scripts=true" not in npmrc:
        errors.append(f"{directory}/.npmrc: must set the npm registry and ignore-scripts=true")

    if (d / "package-lock.json").exists():
        lock = json.loads((d / "package-lock.json").read_text())
        if (d / "yarn.lock").exists() or (d / "bun.lock").exists():
            errors.append(f"{directory}: more than one lockfile")
        for key, entry in lock["packages"].items():
            if not key or entry.get("link"):
                continue
            if not entry.get("resolved", "").startswith(REGISTRIES[0]):
                errors.append(f"{directory}/package-lock.json: {key} resolves outside the npm registry")
            if not entry.get("integrity"):
                errors.append(f"{directory}/package-lock.json: {key} has no integrity hash")
    elif (d / "yarn.lock").exists():
        if "ignore-scripts true" not in ((d / ".yarnrc").read_text() if (d / ".yarnrc").exists() else ""):
            errors.append(f"{directory}/.yarnrc: must set ignore-scripts true")
        for block in (d / "yarn.lock").read_text().split("\n\n"):
            m = re.search(r'^  resolved "([^"]+)"', block, re.M)
            if not m:
                continue
            url, head = m.group(1), block.strip().splitlines()[0]
            if PINNED_GIT.fullmatch(url):
                continue
            if not url.startswith(REGISTRIES):
                errors.append(f"{directory}/yarn.lock: {head} resolves outside the npm registry")
            if not re.search(r"^  integrity ", block, re.M) and not re.search(r"#[0-9a-f]{40}$", url):
                errors.append(f"{directory}/yarn.lock: {head} has no integrity hash")
    elif (d / "bun.lock").exists():
        bunfig = (d / "bunfig.toml").read_text() if (d / "bunfig.toml").exists() else ""
        if 'registry = "https://registry.npmjs.org"' not in bunfig or manifest.get("trustedDependencies"):
            errors.append(f"{directory}: bunfig.toml must set the npm registry and no package may be trusted to run scripts")
        packages = (d / "bun.lock").read_text().split('"packages": {', 1)[1]
        for line in packages.splitlines():
            m = re.match(r'\s*"([^"]+)": \["([^"]+)", "([^"]*)",', line)
            if not m:
                continue
            if m.group(3) and not m.group(3).startswith(REGISTRIES[0]):
                errors.append(f"{directory}/bun.lock: {m.group(2)} resolves outside the npm registry")
            if '"sha512-' not in line:
                errors.append(f"{directory}/bun.lock: {m.group(2)} has no integrity hash")
    else:
        errors.append(f"{directory}: no lockfile")


check_workflows()
check_submodules()
for package_dir in sys.argv[1:]:
    check_package(package_dir)
print("\n".join(errors) if errors else "supply-chain policy: ok")
sys.exit(1 if errors else 0)
