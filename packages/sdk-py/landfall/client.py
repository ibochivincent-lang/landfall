"""
landfall.client
Author: ibochivincent-lang

Lightweight client for Landfall settlement intelligence and counterparty risk evaluation.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class LandfallError(Exception):
    """Base exception for all Landfall SDK errors."""
    pass


class LandfallHttpError(LandfallError):
    """Raised when an HTTP error status is returned by the Landfall API."""
    def __init__(self, status_code: int, message: str, payload: Optional[Dict[str, Any]] = None):
        super().__init__(f"HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload or {}


class LandfallClient:
    """Client for Landfall settlement intelligence APIs."""

    def __init__(
        self,
        base_url: str = "https://landfall-chi.vercel.app",
        api_key: Optional[str] = None,
        timeout: float = 12.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            if query:
                url = f"{url}?{query}"

        headers = {
            "Accept": "application/json",
            "User-Agent": "landfall-python-sdk/0.1.0",
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key

        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                if not raw:
                    return {}
                return json.loads(raw)
        except urllib.error.HTTPError as err:
            error_body: Dict[str, Any] = {}
            try:
                raw_err = err.read().decode("utf-8")
                error_body = json.loads(raw_err)
            except Exception:
                pass
            msg = error_body.get("error") or err.reason or f"HTTP {err.code}"
            raise LandfallHttpError(err.code, msg, error_body) from err
        except urllib.error.URLError as err:
            raise LandfallError(f"Network error connecting to Landfall: {err.reason}") from err

    def get_health(self) -> Dict[str, Any]:
        """Check API service health."""
        return self._request("GET", "/health")

    def get_anchors(self) -> Dict[str, Any]:
        """Fetch all tracked anchors, accounts, reliability scores, and scan coverage."""
        return self._request("GET", "/api/v1/anchors")

    def get_anchor_health(self, domain: str) -> Dict[str, Any]:
        """Fetch pre-flight wallet health score (0-100) for a specific anchor domain."""
        return self._request("GET", f"/api/v1/anchors/{urllib.parse.quote(domain)}/health-check")

    def get_anchor_slippage(self, domain: str) -> Dict[str, Any]:
        """Fetch median quoted-vs-landed execution slippage for an anchor."""
        return self._request("GET", f"/api/v1/anchors/{urllib.parse.quote(domain)}/slippage")

    def trust_check(self, address: str) -> Dict[str, Any]:
        """Run counterparty risk analysis on a Stellar address (G..., MED..., C..., or txHash)."""
        return self._request("GET", "/api/v1/trust-check", params={"address": address})

    def batch_trust_check(self, addresses: List[str]) -> Dict[str, Any]:
        """Run trust check evaluation across multiple Stellar counterparties."""
        return self._request("POST", "/api/v1/trust-check/batch", body={"addresses": addresses})

    def solve_intent(
        self,
        from_asset: str,
        to_asset: str,
        amount: float,
        basis: str = "send",
        min_grade: Optional[str] = None,
        sort_by: str = "payout",
    ) -> Dict[str, Any]:
        """
        Solve a cross-border or off-ramp payment intent, ranking viable settlement corridors.
        """
        body: Dict[str, Any] = {
            "from": from_asset,
            "to": to_asset,
            "amount": amount,
            "basis": basis,
            "sortBy": sort_by,
        }
        if min_grade:
            body["minGrade"] = min_grade
        return self._request("POST", "/api/v1/intent", body=body)

    def check_x402_payees(self, accepts: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Run Trust Check against every Stellar payee in an x402 402 response's accepts array
        before an AI agent signs or authorizes payment.
        """
        return self._request("POST", "/api/v1/x402/check-payee", body={"accepts": accepts})
