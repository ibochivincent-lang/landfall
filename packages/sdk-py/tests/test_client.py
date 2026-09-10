"""
packages/sdk-py/tests/test_client.py
Author: ibochivincent-lang

Unit tests for Landfall Python SDK client.
"""

import io
import json
import os
import sys
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

# Ensure landfall package is importable without prior installation
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from landfall.client import LandfallClient, LandfallError, LandfallHttpError


class TestLandfallClient(unittest.TestCase):
    def setUp(self):
        self.client = LandfallClient(base_url="https://test.landfall.stellar", timeout=5.0)

    @patch("urllib.request.urlopen")
    def test_get_health(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"ok": True}).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.client.get_health()
        self.assertEqual(res, {"ok": True})
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_full_url(), "https://test.landfall.stellar/health")
        self.assertEqual(req.get_method(), "GET")

    @patch("urllib.request.urlopen")
    def test_trust_check(self, mock_urlopen):
        payload = {
            "address": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            "score": 85,
            "flags": [],
        }
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(payload).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.client.trust_check("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
        self.assertEqual(res["score"], 85)
        req = mock_urlopen.call_args[0][0]
        self.assertIn("address=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", req.get_full_url())

    @patch("urllib.request.urlopen")
    def test_solve_intent(self, mock_urlopen):
        payload = {"unsatisfiable": False, "solutions": [{"domain": "test.com", "receive": 150000}]}
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(payload).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.client.solve_intent(from_asset="USDC", to_asset="NGN", amount=100.0, min_grade="B")
        self.assertEqual(len(res["solutions"]), 1)
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["from"], "USDC")
        self.assertEqual(body["to"], "NGN")
        self.assertEqual(body["amount"], 100.0)
        self.assertEqual(body["minGrade"], "B")

    @patch("urllib.request.urlopen")
    def test_check_x402_payees(self, mock_urlopen):
        payload = {"results": [{"payTo": "GABC...", "ok": True}]}
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(payload).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        accepts = [{"network": "stellar:pubnet", "payTo": "GABC...", "amount": "100"}]
        res = self.client.check_x402_payees(accepts)
        self.assertEqual(res["results"][0]["ok"], True)
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_full_url(), "https://test.landfall.stellar/api/v1/x402/check-payee")

    @patch("urllib.request.urlopen")
    def test_http_error_handling(self, mock_urlopen):
        err_fp = io.BytesIO(json.dumps({"error": "Account not found on ledger"}).encode("utf-8"))
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://test.landfall.stellar/api/v1/trust-check",
            code=404,
            msg="Not Found",
            hdrs={},
            fp=err_fp,
        )

        with self.assertRaises(LandfallHttpError) as ctx:
            self.client.trust_check("GUNKNOWN")

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("Account not found on ledger", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
