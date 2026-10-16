"""Offline tests: fixture instructions are test data, not safety advice."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

MODULE = Path(__file__).resolve().parents[1] / "tools" / "drill_rag.py"


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.exists(), "RAG service not implemented")
        spec = importlib.util.spec_from_file_location("drill_rag", MODULE)
        assert spec is not None and spec.loader is not None
        self.rag = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.rag)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.chunks = [
            {
                "id": "law",
                "title": "Law",
                "section": "1",
                "url": "https://example.org/law",
                "text": "Alarm drill",
                "kind": "legal",
                "tags": ["alarm"],
                "actions": ["a"],
            },
            {
                "id": "company",
                "title": "Company",
                "section": "2",
                "url": "company.md",
                "text": "Alarm drill",
                "kind": "company",
                "site_id": "factory-demo-fr-v1",
                "tags": ["alarm"],
                "actions": ["a"],
            },
        ]
        self.actions = {
            "a": {
                "text": "Exact approved fixture text.",
                "citations": ["law", "company"],
                "scenarios": ["alarm"],
            }
        }
        self.save()
        self.request = {
            "scenario": "alarm",
            "zone_id": "workshop",
            "site_id": "factory-demo-fr-v1",
        }

    def test_local_reference_never_calls_model_and_requires_evidence(self):
        self.write_binding()
        infer = Mock(side_effect=AssertionError("Reference must stay local"))
        service = self.rag.Service(self.root, config={}, infer=infer)
        result = service.reference()
        self.assertEqual(result["fingerprint"], "fixture-fingerprint")
        self.assertEqual(
            result["scenarios"]["alarm"]["actions"][0]["text"],
            self.actions["a"]["text"],
        )
        self.assertEqual(result["scenarios"]["alarm"]["mode"], "reference")
        self.assertEqual(result["scenarios"]["smoke"]["actions"], [])
        self.chunks = self.chunks[:1]
        self.save()
        self.assertEqual(service.reference()["scenarios"]["alarm"]["actions"], [])
        (self.root / "site_binding.json").unlink()
        self.assertEqual(service.reference()["scenarios"], {})
        infer.assert_not_called()

    def test_binding_required_and_zone_validated(self):
        self.write_binding()
        service = self.rag.Service(
            self.root, config={}, infer=Mock(return_value={"action_ids": ["a"]})
        )
        for updates in (
            {"site_fingerprint": "wrong"},
            {"zone_id": "workshop"},
            {"site_id": "other"},
            {"scenario": "other"},
        ):
            with (
                self.subTest(updates=updates),
                self.assertRaises(self.rag.RequestError),
            ):
                service.guidance(dict(self.request, **updates))

    def write_binding(self):
        (self.root / "site_binding.json").write_text(
            json.dumps(
                {
                    "site_id": "factory-demo-fr-v1",
                    "fingerprint": "fixture-fingerprint",
                    "zones": [{"id": "Z1", "name": "Production Hall"}],
                    "doors": [],
                }
            )
        )
        self.request.update(zone_id="Z1", site_fingerprint="fixture-fingerprint")

    def test_required_actions_survive_model_omission(self):
        self.write_binding()
        self.actions["b"] = dict(
            self.actions["a"], text="Required fixture.", required=True
        )
        for chunk in self.chunks:
            chunk["actions"].append("b")
        self.save()
        service = self.rag.Service(
            self.root, config={}, infer=Mock(return_value={"action_ids": ["a"]})
        )
        result = service.guidance(self.request)
        self.assertEqual({a["id"] for a in result["actions"]}, {"a", "b"})

    def test_invalid_selection_falls_back_without_generated_text(self):
        self.write_binding()
        for answer in (
            {"action_ids": ["invented"]},
            {"action_ids": ["a"], "text": "unsafe"},
            {"action_ids": []},
        ):
            service = self.rag.Service(
                self.root, config={}, infer=Mock(return_value=answer)
            )
            result = service.guidance(self.request)
            self.assertEqual(result["error"], "invalid_selection")
            self.assertEqual(result["mode"], "fallback")
            self.assertEqual([a["id"] for a in result["actions"]], ["a"])

    def test_errors_do_not_disclose_details(self):
        self.write_binding()
        service = self.rag.Service(
            self.root, config={}, infer=Mock(side_effect=RuntimeError("SECRET"))
        )
        result = service.guidance(self.request)
        self.assertEqual(result["error"], "provider_error")
        self.assertNotIn("SECRET", json.dumps(result))
        service = self.rag.Service(self.root, config={})
        self.assertEqual(service.guidance(self.request)["error"], "missing_config")

    def test_missing_or_one_sided_evidence_has_no_actions(self):
        self.write_binding()
        self.chunks = self.chunks[:1]
        self.save()
        infer = Mock()
        service = self.rag.Service(self.root, config={}, infer=infer)
        self.assertEqual(service.guidance(self.request)["actions"], [])
        (self.root / "chunks.json").unlink()
        self.assertEqual(service.guidance(self.request)["error"], "corpus_unavailable")
        infer.assert_not_called()

    def test_http_boundaries_and_static_frontend(self):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer

        self.write_binding()
        (self.root / "index.html").write_text("fixture frontend")
        service = self.rag.Service(self.root, config={})
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), self.rag.make_handler(service, self.root)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_port

        def request(method, path, body=None, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            try:
                conn.request(method, path, body=body, headers=headers or {})
                response = conn.getresponse()
                return response.status, response.read(), dict(response.getheaders())
            finally:
                conn.close()

        self.assertEqual(request("GET", "/")[1], b"fixture frontend")
        self.assertEqual(request("GET", "/api/rag-status")[0], 200)
        code, raw, _ = request("GET", "/api/drill-reference")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["scenarios"]["alarm"]["mode"], "reference")
        self.assertEqual(
            request(
                "GET", "/api/drill-reference", headers={"Host": "attacker.example"}
            )[0],
            403,
        )
        self.assertEqual(
            request("GET", "/api/rag-status", headers={"Host": "attacker.example"})[0],
            403,
        )
        body = json.dumps(self.request)
        headers = {
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{port}",
        }
        status, raw, response_headers = request("POST", "/api/guidance", body, headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["error"], "missing_config")
        self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        headers["Origin"] = "https://evil.example"
        self.assertEqual(request("POST", "/api/guidance", body, headers)[0], 403)
        headers.pop("Origin")
        self.assertEqual(request("POST", "/api/guidance", "x" * 2049, headers)[0], 413)

    def test_provider_contract_https_timeout_and_bounded_prompt(self):
        from unittest.mock import patch

        self.write_binding()
        config = {
            "AMD_BASE_URL": "https://provider.example/v1",
            "AMD_MODEL": "fixture",
            "API_KEY": "SECRET",
        }
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(
            {"choices": [{"message": {"content": '{"action_ids":["a"]}'}}]}
        ).encode()
        opener = Mock()
        opener.open.return_value = response
        with patch.object(self.rag.urllib.request, "build_opener", return_value=opener):
            result = self.rag.Service(self.root, config=config).guidance(self.request)
        self.assertEqual(result["mode"], "model")
        args, kwargs = opener.open.call_args
        self.assertEqual(kwargs["timeout"], 60)
        payload = json.loads(args[0].data)
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})
        self.assertNotIn("SECRET", json.dumps(result))
        with self.assertRaises(self.rag.MissingConfig):
            self.rag.endpoint(dict(config, AMD_BASE_URL="http://provider.example/v1"))

    def test_missing_required_evidence_fails_closed(self):
        self.write_binding()
        self.actions["mandatory"] = dict(
            self.actions["a"], required=True, citations=["missing"]
        )
        self.save()
        result = self.rag.Service(self.root, config={}).guidance(self.request)
        self.assertEqual(result["error"], "insufficient_evidence")
        self.assertEqual(result["actions"], [])

    def save(self):
        (self.root / "chunks.json").write_text(json.dumps(self.chunks))
        (self.root / "actions.json").write_text(json.dumps(self.actions))

    def test_valid_selection_renders_only_bank_text(self):
        self.write_binding()
        infer = Mock(return_value={"action_ids": ["a"]})
        service = self.rag.Service(self.root, config={}, infer=infer)
        result = service.guidance(self.request)
        self.assertEqual(result["mode"], "model")
        self.assertEqual(result["actions"][0]["text"], self.actions["a"]["text"])
        self.assertEqual(
            [c["id"] for c in result["actions"][0]["citations"]], ["law", "company"]
        )
        self.assertEqual(
            infer.call_args.args[0]["situation"],
            {k: v for k, v in self.request.items() if k != "site_fingerprint"},
        )


if __name__ == "__main__":
    unittest.main()
