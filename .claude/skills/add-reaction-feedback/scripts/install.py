#!/usr/bin/env python3
"""Apply the fork's reaction feedback recipe without replacing unrelated source files."""
import shutil
import subprocess
from pathlib import Path

skill = Path(__file__).resolve().parent.parent
root = skill.parents[2]
patch = skill / 'integration.patch'
check = subprocess.run(['git', 'apply', '--check', str(patch)], cwd=root, capture_output=True)
if check.returncode == 0:
    subprocess.run(['git', 'apply', str(patch)], cwd=root, check=True)
else:
    applied = subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=root, capture_output=True)
    if applied.returncode:
        raise SystemExit('Integration differs from this recipe. Inspect integration.patch and adapt its small reach-ins; no files were copied.')
shutil.copytree(skill / 'payload' / 'reaction-feedback', root / 'src/modules/reaction-feedback', dirs_exist_ok=True)
print('Reaction feedback applied. Build and run the skill tests before restarting the detected host service.')
