"""Offline public-hosting security and global quota regression tests."""

import http.client
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "hosting_rag", Path(__file__).resolve().parents[1] / "tools/drill_rag.py"
)
assert SPEC is not None and SPEC.loader is not None
rag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rag)


class HostingTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def server(self):
        service = rag.Service(config={})
        server = ThreadingHTTPServer(("127.0.0.1", 0), rag.make_handler(service))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server, host, origin=None, extra=None, path="/api/rag-status"):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        headers = {"Host": host, **(extra or {})}
        if origin is not None:
            headers["Origin"] = origin
        try:
            conn.request("GET", path, headers=headers)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_environment_credentials_override_file_without_disclosure(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "amd.env"
            env_file.write_text("API_KEY=file-secret\nAMD_MODEL=file-model\n")
            os.environ.update(API_KEY="environment-secret", AMD_MODEL="env-model")
            config = rag.load_config(env_file)
            self.assertEqual(config["API_KEY"], "environment-secret")
            self.assertEqual(config["AMD_MODEL"], "env-model")
            self.assertNotIn("secret", json.dumps(rag.Service(config=config).status()))

    def test_exact_public_host_origin_and_health(self):
        os.environ["PUBLIC_BASE_URL"] = "https://demo.onrender.com"
        server = self.server()
        for origin in (None, "https://demo.onrender.com"):
            self.assertEqual(self.request(server, "demo.onrender.com", origin)[0], 200)
        for host, origin in (
            ("evil.example", None),
            ("demo.onrender.com.evil.example", None),
            ("demo.onrender.com", "http://demo.onrender.com"),
            ("demo.onrender.com", "https://evil.example"),
            ("demo.onrender.com:443", None),
        ):
            self.assertEqual(self.request(server, host, origin)[0], 403)
        self.assertEqual(
            self.request(
                server,
                "evil.example",
                extra={
                    "X-Forwarded-Host": "demo.onrender.com",
                    "X-Forwarded-Proto": "https",
                },
            )[0],
            403,
        )
        code, raw = self.request(server, "demo.onrender.com", path="/healthz")
        self.assertEqual((code, json.loads(raw)), (200, {"status": "ok"}))

    def test_native_render_fallback_and_local_default(self):
        server = self.server()
        self.assertEqual(self.request(server, "demo.onrender.com")[0], 403)
        self.assertEqual(
            self.request(server, f"127.0.0.1:{server.server_port}")[0], 200
        )
        os.environ["RENDER_EXTERNAL_URL"] = "https://native.onrender.com"
        server = self.server()
        self.assertEqual(self.request(server, "native.onrender.com")[0], 200)
        os.environ["PUBLIC_BASE_URL"] = "https://explicit.example"
        server = self.server()
        self.assertEqual(self.request(server, "native.onrender.com")[0], 403)
        self.assertEqual(self.request(server, "explicit.example")[0], 200)

    def test_invalid_public_configuration_fails_closed(self):
        for value in (
            "http://demo.example",
            "https://a:b@demo.example",
            "https://demo.example/path",
            "https://demo.example?query",
            "https://demo.example#fragment",
            "https://demo.example:bad",
        ):
            with (
                self.subTest(value=value),
                patch.dict(os.environ, PUBLIC_BASE_URL=value),
            ):
                with self.assertRaises(ValueError):
                    rag.make_handler(rag.Service(config={}))

    def test_cli_host_and_port_environment(self):
        os.environ["PORT"] = "10000"
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with (
            patch.object(rag, "ThreadingHTTPServer", return_value=server) as factory,
            patch("sys.argv", ["drill_rag.py", "--host", "0.0.0.0"]),
            patch("builtins.print"),
        ):
            rag.main()
        self.assertEqual(factory.call_args.args[0], ("0.0.0.0", 10000))

    def service_request(self, infer):
        service = rag.Service(config={}, infer=infer)
        binding = service.binding()
        request = dict(
            scenario="alarm",
            zone_id="Z1",
            site_id=rag.SITE_ID,
            site_fingerprint=binding["fingerprint"],
        )
        return service, request

    @staticmethod
    def select(prompt):
        return {"action_ids": [prompt["candidates"][0]["id"]]}

    def test_cache_reuses_finite_events_but_revalidates_binding(self):
        infer = Mock(side_effect=self.select)
        service, request = self.service_request(infer)
        first = service.guidance(request)
        self.assertEqual(first["mode"], "model")
        self.assertEqual(service.guidance(request), first)
        self.assertEqual(infer.call_count, 1)
        with self.assertRaises(rag.RequestError):
            service.guidance(dict(request, site_fingerprint="wrong"))
        with patch.object(service, "corpus", return_value=([], {})):
            self.assertEqual(service.guidance(request)["error"], "corpus_unavailable")

    def test_global_hourly_budget_invalid_requests_and_clock_expiry(self):
        os.environ["MODEL_CALLS_PER_HOUR"] = "1"
        infer = Mock(side_effect=self.select)
        service, request = self.service_request(infer)
        with self.assertRaises(rag.RequestError):
            service.guidance(dict(request, scenario="bad"))
        with patch.object(time, "monotonic", return_value=100):
            self.assertEqual(service.guidance(request)["mode"], "model")
            blocked = service.guidance(dict(request, zone_id="Z2"))
        self.assertEqual(blocked["error"], "model_budget_exhausted")
        self.assertEqual(blocked["mode"], "fallback")
        self.assertTrue(blocked["actions"][0]["citations"])
        self.assertEqual(infer.call_count, 1)
        with patch.object(time, "monotonic", return_value=3701):
            self.assertEqual(
                service.guidance(dict(request, zone_id="Z2"))["mode"], "model"
            )
        self.assertEqual(infer.call_count, 2)

    def test_concurrent_requests_fall_back_without_extra_provider_calls(self):
        os.environ["MODEL_MAX_CONCURRENCY"] = "1"
        entered, release = threading.Event(), threading.Event()

        def slow(prompt):
            entered.set()
            self.assertTrue(release.wait(3))
            return self.select(prompt)

        infer = Mock(side_effect=slow)
        service, request = self.service_request(infer)
        worker = threading.Thread(target=service.guidance, args=(request,))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            for zone in ("Z1", "Z2"):
                result = service.guidance(dict(request, zone_id=zone))
                self.assertEqual(result["error"], "model_busy")
                self.assertTrue(result["actions"])
            self.assertEqual(infer.call_count, 1)
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(service.guidance(request)["mode"], "model")
        self.assertEqual(infer.call_count, 1)

    def test_transient_errors_are_not_cached_and_cache_is_bounded(self):
        os.environ["MODEL_CACHE_SIZE"] = "1"
        infer = Mock()
        service, request = self.service_request(infer)

        def transient(prompt):
            if infer.call_count == 1:
                raise RuntimeError("SECRET")
            return self.select(prompt)

        infer.side_effect = transient
        self.assertEqual(service.guidance(request)["error"], "provider_error")
        self.assertEqual(service.guidance(request)["mode"], "model")
        service.guidance(dict(request, zone_id="Z2"))
        service.guidance(request)
        self.assertEqual(infer.call_count, 4)

    def test_configurable_body_limit(self):
        os.environ["MAX_BODY_BYTES"] = "32"
        server = self.server()
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            conn.request(
                "POST", "/api/guidance", "x" * 33, {"Content-Type": "application/json"}
            )
            response = conn.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
