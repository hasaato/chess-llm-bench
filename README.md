## Chess Context Protocol + LLM chess playing benchmark

This repo contains source code for running benchmarking code to benchmark how well LLM + CCP can play chess. 

## What is CCP?
CCP is chess context protocol that takes care of providing chess context to LLM, such as legal moves, board state, chess themes etc. You can read more about it [here](https://github.com/jalpp/chessagineweb/tree/main/chessContextProtocol)

### Isn't this cheating?
No CCP does not give the model the best/right move rather the board state, chess themes, and legal moves which it uses to its advantge. LLMs are not meant to play chess, and by adding CCP layer LLMs become chess aware and this project tests how well LLM + CCP combo works.

## Acheivements
Gemini-2.5-pro + Agine system prompt + CCP was able to take down Stockfish 1000 running at depth 15. the `bench` folder contains
on victory json and text files. 

Game:


## Future plans
- playing is one category, there will be more bench tests that be added.

## Setup

```
cd chess-llm-bench\src\bench

npm i

in .env file add the following

AGINE_PROVIDER=

# Model name
AGINE_MODEL=

# API Key (required for google, openai, anthropic)
AGINE_API_KEY=

npx tsx .\playTest.ts 4 # number of games 15 local wasm fish depth 5 api delay 

watch the benchmark happen live
```

## Output

the benchmark generates detailed `benchmark.json` file that contains game info, win rates, game pgn and moves.

json
```
{
  "summary": {
    "totalGames": 2,
    "completedGames": 1,
    "agentWins": 0,
    "stockfishWins": 1,
    "draws": 0,
    "stockfishDepth": 15,
    "apiDelaySeconds": 5,
    "agentTimeoutSeconds": 60,
    "model": "gemini-2.5-pro",
    "provider": "google",
    "ccpEnabled": true,
    "stats": {
      "agentAsWhite": {
        "wins": 0,
        "losses": 1,
        "draws": 0
      },
      "agentAsBlack": {
        "wins": 0,
        "losses": 0,
        "draws": 0
      }
    }
  },
  "games": [
    {
      "winner": "stockfish",
      "reason": "checkmate",
      "moves": [
        "e4",
        "e6",

...

```

## Authors:
@jalpp