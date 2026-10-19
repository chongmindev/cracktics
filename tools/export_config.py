"""Write the settings the browser needs from config.toml to web/src/config.json (committed, generated).

Usage: uv run python tools/export_config.py [--check]
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

from cracktics import config

OUT = Path(__file__).resolve().parent.parent / "web/src/config.json"


def exported() -> str:
    cfg = config.load()
    e = cfg.engine
    data = {"_note": "generated from config.toml by tools/export_config.py; do not edit",
            "engine": {"mate_score": e.mate_score, "eval_cap": e.eval_cap},
            "drills": asdict(cfg.drills),
            "scan": asdict(cfg.scan),
            "scout": asdict(cfg.scout),
            "openings": asdict(cfg.openings),
            "fetch": {"base_url": cfg.fetch.base_url, "min_interval": cfg.fetch.min_interval,
                      "months": cfg.fetch.months, "time_classes": list(cfg.fetch.time_classes)}}
    return json.dumps(data, indent=2) + "\n"


if __name__ == "__main__":
    text = exported()
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text() == text
        print("web/src/config.json is", "up to date" if ok else "STALE: rerun tools/export_config.py")
        sys.exit(0 if ok else 1)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT}")
