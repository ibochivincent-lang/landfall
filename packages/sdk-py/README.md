# Landfall Python SDK (`landfall-sdk`)

Independent settlement intelligence for Stellar — ledger-derived evidence about who you are about to pay.

Author: `ibochivincent-lang`

## Installation

```bash
pip install landfall-sdk
```

For LangChain or CrewAI support:
```bash
pip install "landfall-sdk[langchain]"
pip install "landfall-sdk[crewai]"
```

## Quickstart

```python
from landfall import LandfallClient

client = LandfallClient()

# 1. Run Trust Check on an address before transferring funds
report = client.trust_check("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
print("Score:", report["score"])
print("Flags:", report["flags"])

# 2. Rank settlement routes for a cross-border intent
solution = client.solve_intent(
    from_asset="USDC",
    to_asset="NGN",
    amount=500.0,
    min_grade="B",
)
print("Best Route:", solution["solutions"][0]["name"])
print("Delivered:", solution["solutions"][0]["receive"])

# 3. Guard against rogue payees in an x402 HTTP 402 response
evaluation = client.check_x402_payees(accepts=[
    {"network": "stellar:pubnet", "payTo": "GA5ZSE...", "amount": "100000"}
])
print(evaluation["results"])
```

## LangChain Integration

```python
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI
from landfall.langchain import create_landfall_tools

tools = create_landfall_tools()
llm = ChatOpenAI(model="gpt-4o")

agent = initialize_agent(tools, llm, agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION)
response = agent.run("Should I pay 100 USDC to GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN?")
print(response)
```

## CrewAI Integration

```python
from crewai import Agent, Task, Crew
from landfall.crewai import create_crewai_tools

tools = create_crewai_tools()

treasury_agent = Agent(
    role="Stellar Settlement Auditor",
    goal="Verify counterparties and prevent unauthorized payments",
    backstory="You are an autonomous risk officer guarding cross-border payouts on Stellar.",
    tools=tools,
)
```

## License

MIT License. Authored by `ibochivincent-lang`.
