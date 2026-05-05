from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parent.parent / "python-scans-service"
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from social_alerts_scweet import handle_http, json_response


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        json_response(self, 200, {"ok": True, "service": "social-alerts-scweet"})

    def do_POST(self):
        handle_http(self)
