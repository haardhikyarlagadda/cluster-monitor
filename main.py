"""main.py – CLI entry point."""
from __future__ import annotations
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)

from monitor.config import Settings


def main():
    settings = Settings.from_cli(sys.argv[1:])

    if settings.demo:
        from monitor.demo import DemoCollector
        collector = DemoCollector(settings)
    else:
        from monitor.k8s import Collector
        collector = Collector(settings)

    if settings.web:
        import uvicorn
        from monitor.web import create_app
        app = create_app(settings, collector)
        uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level="info")
    else:
        import json
        from dataclasses import asdict
        snap = collector.snapshot()
        print(json.dumps(asdict(snap), indent=2))


if __name__ == "__main__":
    main()
