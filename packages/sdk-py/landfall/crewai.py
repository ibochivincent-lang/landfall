"""
landfall.crewai
Author: ibochivincent-lang

CrewAI tool integrations for autonomous multi-agent crews.
"""

from __future__ import annotations

from typing import Any, List, Optional
from .client import LandfallClient


def create_crewai_tools(client: Optional[LandfallClient] = None) -> List[Any]:
    """
    Creates CrewAI Tool instances for Landfall counterparty verification.
    Requires crewai or crewai-tools installed.
    """
    try:
        from crewai.tools import tool
    except ImportError:
        try:
            from crewai_tools import tool
        except ImportError:
            raise ImportError(
                "crewai is required to use CrewAI tools. "
                "Install it via: pip install 'landfall-sdk[crewai]' or pip install crewai"
            )

    cl = client or LandfallClient()

    @tool("Stellar Counterparty Trust Check")
    def crewai_trust_check(address: str) -> str:
        """
        Verify any Stellar payment counterparty, checking for zero settlement history,
        recent account creation, suspicious transaction patterns, or community reports.
        """
        try:
            res = cl.trust_check(address)
            return (
                f"Address: {address}\n"
                f"Score: {res.get('score', 0)}/100\n"
                f"Flags: {res.get('flags', [])}\n"
                f"Summary: {res.get('summary', 'Evaluation complete.')}"
            )
        except Exception as err:
            return f"Failed to run Trust Check: {err}"

    return [crewai_trust_check]
