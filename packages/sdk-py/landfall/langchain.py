"""
landfall.langchain
Author: ibochivincent-lang

LangChain tool integrations for autonomous AI agents using Landfall.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from .client import LandfallClient


def create_landfall_tools(client: Optional[LandfallClient] = None) -> List[Any]:
    """
    Creates LangChain BaseTool instances for Landfall counterparty risk evaluation and route ranking.
    Requires langchain-core installed.
    """
    try:
        from langchain_core.tools import tool
    except ImportError:
        raise ImportError(
            "langchain-core is required to use LangChain tools. "
            "Install it via: pip install 'landfall-sdk[langchain]' or pip install langchain-core"
        )

    cl = client or LandfallClient()

    @tool
    def stellar_trust_check(address: str) -> str:
        """
        Evaluate counterparty risk on a Stellar recipient before transferring funds or executing payments.
        Input should be a Stellar public key (G...), Muxed account (MED...), Contract (C...), or transaction hash.
        Returns risk signals, account age, payment history, and trust score.
        """
        try:
            res = cl.trust_check(address)
            flags = res.get("flags", [])
            score = res.get("score", 0)
            return (
                f"Trust Check for {address}:\n"
                f"- Risk Score: {score}/100\n"
                f"- Flagged Signals: {', '.join(flags) if flags else 'None (Clean)'}\n"
                f"- Account Age: {res.get('ageDays', 'Unknown')} days\n"
                f"- Recommendation: {'Proceed with caution' if flags else 'Safe to proceed'}"
            )
        except Exception as err:
            return f"Error conducting Trust Check on {address}: {err}"

    @tool
    def stellar_route_scout(from_asset: str, to_asset: str, amount: float) -> str:
        """
        Find and rank the best settlement corridors on Stellar (e.g., deliver NGN or BRL from USDC).
        Returns ranked routes with fees, delivery speeds, and reliability grades.
        """
        try:
            res = cl.solve_intent(from_asset=from_asset, to_asset=to_asset, amount=amount)
            solutions = res.get("solutions", [])
            if not solutions:
                return f"No viable settlement corridors found from {from_asset} to {to_asset} for amount {amount}."
            top = solutions[0]
            return (
                f"Best route found via {top.get('name')} ({top.get('domain')}):\n"
                f"- Delivered: {top.get('receive')} {to_asset}\n"
                f"- Fee: {top.get('fee')} {from_asset}\n"
                f"- Reliability Grade: {top.get('grade')} (Score: {top.get('score')}/100)\n"
                f"- Liquidity Tier: {top.get('liquidityTier')}"
            )
        except Exception as err:
            return f"Error finding routes: {err}"

    return [stellar_trust_check, stellar_route_scout]
