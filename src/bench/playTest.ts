import { Chess } from "chess.js";
import { chessAgine } from "../mastra/agents";
import { RuntimeContext } from "@mastra/core/di";
import { getBoardState } from "../themes/state";
import { PositionPrompter } from "../themes/positionPrompter";
import { TacticalBoard } from "../themes/tacticalBoard";
import fs from "fs";
import { MCPStockfish } from "../engine/MCPStockfish";

import * as dotenv from "dotenv";
import { formatEvaluation, formatStockfishPositionEval } from "../engine/format";

dotenv.config();

interface GameResult {
  winner: "agent" | "stockfish" | "draw";
  reason: string;
  moves: string[];
  pgn: string;
  finalFen: string;
  moveCount: number;
}

interface GameStats {
  agentAsWhite: { wins: number; losses: number; draws: number };
  agentAsBlack: { wins: number; losses: number; draws: number };
}

// Get configuration from environment or use defaults
const model = process.env.AGINE_MODEL || "gemini-2.5-flash";
const provider = process.env.AGINE_PROVIDER || "google";
const apiKey = process.env.AGINE_API_KEY || "";

// Parse command line arguments
const args = process.argv.slice(2);
const useCCP = !args.includes("--no-ccp");
const filteredArgs = args.filter(arg => arg !== "--no-ccp");

// Validate API key if using external providers
if ((provider === "google" || provider === "openai" || provider === "anthropic") && !apiKey || apiKey === "") {
  console.warn("⚠️  Warning: No API key found in environment variables!");
  console.warn(`   Please set AGINE_API_KEY in your .env file for ${provider} provider.`);
}

// Rate limiting helper
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Timeout wrapper for promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

async function getStockfishMove(fen: string, depth: number = 15, elo: number = 1000): Promise<string> {
  console.log("Calling Local Stockfish");
  
  try {
    const engine = await MCPStockfish.create();
    engine.setElo(elo); // change elo
    await engine.init();
    const data = await engine.evaluatePositionWithUpdate({
        fen: fen,
        depth: depth,
        multiPv: 2
    })
    const analysis = formatStockfishPositionEval(fen, data);
    
    console.log(`Stockfish eval: ${formatEvaluation(data.lines[0])}`);
    console.log(`Stockfish ELO: ${engine.getElo}`)
    console.log(`Best line: ${analysis.topLine}`);
    
    return analysis.bestmove;
  } catch (error) {
    console.error("Stockfish API error:", error);
    throw new Error("Failed to get Stockfish move");
  }
}

async function getAgentMove(
  fen: string, 
  agentColor: string, 
  runtimeContext: RuntimeContext,
  useCCP: boolean,
  timeoutMs: number = 60000
): Promise<string> {
  console.log(`${model} ChessAgine thinking... ${useCCP ? '(with CCP)' : '(no CCP)'}`);

  let prompt: string;

  if (useCCP) {
    // Full CCP prompt with board state and tactics
    const state = getBoardState(fen);
    const tactics = new TacticalBoard(fen);
    const positionPrompter = new PositionPrompter(state);

    prompt = `You are playing a chess game. Current position FEN: ${fen}
You are playing as ${agentColor}.

${positionPrompter.generatePrompt()}

${tactics.toString()}

### Legal moves:
${state.legalMoves.join(",")}

Return ONLY the best LEGAL move using the framework in standard algebraic notation (SAN) format.
Do not include any explanation, analysis, or additional text. Just the move.`;
  } else {
    // Simple prompt without CCP
    const chess = new Chess(fen);
    const legalMoves = chess.moves();

    prompt = `You are playing a chess game. Current position FEN: ${fen}
You are playing as ${agentColor}.

### Legal moves:
${legalMoves.join(",")}

Return ONLY the best LEGAL move in standard algebraic notation (SAN) format.
Do not include any explanation, analysis, or additional text. Just the move.`;
  }

  try {
    const response = await withTimeout(
      chessAgine.generate(prompt, { runtimeContext }),
      timeoutMs,
      `Agent response timeout after ${timeoutMs / 1000} seconds`
    );

    let agentMove = response.text.trim();
    
    // Clean up response - remove common formatting
    agentMove = agentMove.replace(/```/g, "");
    agentMove = agentMove.replace(/\*\*/g, "");
    agentMove = agentMove.split("\n")[0].trim();
    
    console.log(`Agent raw response: "${agentMove}"`);
    
    return agentMove;
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout")) {
      console.error(`⏱️  Agent timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  }
}

async function validateAndMakeMove(chess: Chess, moveStr: string, playerName: string): Promise<string> {
  try {
    const result = chess.move(moveStr);
    console.log(`${playerName} played: ${result.san}`);
    return result.san;
  } catch (error) {
    console.error(`Invalid move from ${playerName}: ${moveStr}`);
    console.log("Legal moves:", chess.moves().join(", "));
    
    // Try to find a matching legal move
    const legalMoves = chess.moves();
    const foundMove = legalMoves.find(m => 
      moveStr.includes(m) || 
      m.toLowerCase() === moveStr.toLowerCase() ||
      moveStr.replace(/[+#]/g, "") === m.replace(/[+#]/g, "")
    );
    
    if (foundMove) {
      const result = chess.move(foundMove);
      console.log(`Corrected to: ${result.san}`);
      return result.san;
    } else {
      throw new Error(`${playerName} produced invalid move: ${moveStr}`);
    }
  }
}

async function playGame(
  agentColor: "white" | "black",
  stockfishDepth: number = 15,
  maxMoves: number = 200,
  apiDelaySeconds: number = 1,
  useCCP: boolean = true,
  agentTimeoutSeconds: number = 60,
  stockfishElo: number = 1000
): Promise<GameResult> {
  const chess = new Chess();
  const moves: string[] = [];

  console.log("\n" + "=".repeat(60));
  console.log(`NEW GAME: ${model} Agent plays as ${agentColor} ${useCCP ? '(with CCP)' : '(no CCP)'}`);
  console.log(`Agent timeout: ${agentTimeoutSeconds}s`);
  console.log("=".repeat(60));

  const runtimeContext = new RuntimeContext();
  runtimeContext.set("provider", provider);
  runtimeContext.set("model", model);
  runtimeContext.set("apiKey", apiKey);
  runtimeContext.set("lang", "English");
  runtimeContext.set("mode", useCCP ? "bench" : "bench-no-ccp");
  runtimeContext.set("isRouted", false);

  // Add Ollama base URL if using Ollama
  if (provider === "ollama") {
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/api";
    runtimeContext.set("ollamaBaseUrl", ollamaBaseUrl);
  }

  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;
  let agentTimeouts = 0;

  while (!chess.isGameOver() && moves.length < maxMoves) {
    const currentFen = chess.fen();
    const currentTurn = chess.turn() === "w" ? "white" : "black";
    const moveNumber = Math.floor(moves.length / 2) + 1;

    console.log(`\n--- Move ${moveNumber} - ${currentTurn}'s turn ---`);

    try {
      let move: string;

      if (currentTurn === agentColor) {
        // Agent's turn
        const startTime = Date.now();
        const agentMove = await getAgentMove(
          currentFen, 
          agentColor, 
          runtimeContext, 
          useCCP,
          agentTimeoutSeconds * 1000
        );
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`⏱️  Agent responded in ${elapsedTime}s`);
        
        move = await validateAndMakeMove(chess, agentMove, "Agent");
        consecutiveErrors = 0; // Reset error counter on success
        agentTimeouts = 0; // Reset timeout counter on success
      } else {
        // Stockfish's turn
        const stockfishMove = await getStockfishMove(currentFen, stockfishDepth, stockfishElo);
        move = await validateAndMakeMove(chess, stockfishMove, "Stockfish");
        consecutiveErrors = 0; // Reset error counter on success
      }

      moves.push(move);
      
      // Show position periodically
      console.log("Current Position:")
      console.log("Lichess GIF: ")
      chess.ascii();

      // Small delay to avoid overwhelming the API
      await sleep(apiDelaySeconds * 1000);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes("timeout");
      
      if (isTimeout) {
        agentTimeouts++;
        console.error(`⏱️  Agent timeout (${agentTimeouts}/${maxConsecutiveErrors})`);
        
        if (agentTimeouts >= maxConsecutiveErrors) {
          console.error(`Too many consecutive timeouts (${maxConsecutiveErrors}). Ending game.`);
          break;
        }
        
        console.log("Retrying with fresh context...");
        await sleep(5000);
      } else {
        console.error("Error during move:", error);
        consecutiveErrors++;
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`Too many consecutive errors (${maxConsecutiveErrors}). Ending game.`);
          break;
        }
        
        // Wait a bit before retrying
        await sleep(5000);
      }
    }
  }

  // Determine result
  let winner: "agent" | "stockfish" | "draw";
  let reason: string;

  if (chess.isCheckmate()) {
    const loser = chess.turn() === "w" ? "white" : "black";
    winner = loser === agentColor ? "stockfish" : "agent";
    reason = "checkmate";
  } else if (chess.isDraw()) {
    winner = "draw";
    if (chess.isStalemate()) reason = "stalemate";
    else if (chess.isThreefoldRepetition()) reason = "threefold repetition";
    else if (chess.isInsufficientMaterial()) reason = "insufficient material";
    else reason = "50-move rule";
  } else if (consecutiveErrors >= maxConsecutiveErrors) {
    winner = "stockfish";
    reason = "game abandoned due to errors";
  } else if (agentTimeouts >= maxConsecutiveErrors) {
    winner = "stockfish";
    reason = "game abandoned due to timeouts";
  } else {
    winner = "draw";
    reason = "max moves reached";
  }

  console.log(`\nFinal position:\n${chess.ascii()}`);

  const result: GameResult = {
    winner,
    reason,
    moves,
    pgn: chess.pgn(),
    finalFen: chess.fen(),
    moveCount: moves.length,
  };

  return result;
}

async function runBenchmark(
  games: number = 5,
  stockfishDepth: number = 15,
  apiDelaySeconds: number = 1,
  useCCP: boolean = true,
  agentTimeoutSeconds: number = 60,
  stockfishElo: number = 1000
): Promise<void> {
  console.log("=".repeat(70));
  console.log("CHESS AGINE BENCHMARK TEST - WASM Stockfish");
  console.log("=".repeat(70));
  console.log(`Number of games: ${games}`);
  console.log(`Stockfish depth: ${stockfishDepth}`);
  console.log(`API delay: ${apiDelaySeconds} seconds`);
  console.log(`Agent timeout: ${agentTimeoutSeconds} seconds`);
  console.log(`Model: ${model} (${provider})`);
  console.log(`CCP Mode: ${useCCP ? 'ENABLED (with board state & tactics)' : 'DISABLED (FEN only)'}`);
  console.log(`Estimated total time: ~${Math.ceil((games * 40 * apiDelaySeconds) / 60)} minutes`);
  console.log("=".repeat(70));

  const results: GameResult[] = [];
  const stats: GameStats = {
    agentAsWhite: { wins: 0, losses: 0, draws: 0 },
    agentAsBlack: { wins: 0, losses: 0, draws: 0 },
  };

  for (let i = 0; i < games; i++) {
    const agentColor: "white" | "black" = i % 2 === 0 ? "white" : "black";
    
    console.log(`\n${"=".repeat(70)}`);
    console.log(`GAME ${i + 1}/${games} - Agent as ${agentColor}`);
    console.log(`${"=".repeat(70)}`);

    try {
      const result = await playGame(
        agentColor, 
        stockfishDepth, 
        200, 
        apiDelaySeconds, 
        useCCP,
        agentTimeoutSeconds,
        stockfishElo
      );
      results.push(result);

      // Update stats
      const colorStats = agentColor === "white" ? stats.agentAsWhite : stats.agentAsBlack;
      if (result.winner === "agent") colorStats.wins++;
      else if (result.winner === "stockfish") colorStats.losses++;
      else colorStats.draws++;

      console.log(`\n${"=".repeat(70)}`);
      console.log(`GAME ${i + 1} RESULT`);
      console.log(`${"=".repeat(70)}`);
      console.log(`Winner: ${result.winner}`);
      console.log(`Reason: ${result.reason}`);
      console.log(`Total moves: ${result.moveCount}`);
      console.log(`Agent color: ${agentColor}`);
      console.log(`\nPGN:\n${result.pgn}`);

      // Save intermediate results after each game
      saveResults(results, stats, games, stockfishDepth, apiDelaySeconds, useCCP, agentTimeoutSeconds);
    } catch (error) {
      console.error(`\nGame ${i + 1} failed:`, error);
    }

    // Extra delay between games
    if (i < games - 1) {
      console.log(`\nWaiting ${apiDelaySeconds} seconds before next game...`);
      await sleep(apiDelaySeconds * 1000);
    }
  }

  // Print final summary
  printSummary(results, stats, games);
}

function printSummary(results: GameResult[], stats: GameStats, totalGames: number): void {
  const agentWins = stats.agentAsWhite.wins + stats.agentAsBlack.wins;
  const stockfishWins = stats.agentAsWhite.losses + stats.agentAsBlack.losses;
  const draws = stats.agentAsWhite.draws + stats.agentAsBlack.draws;

  console.log(`\n${"=".repeat(70)}`);
  console.log("BENCHMARK SUMMARY");
  console.log(`${"=".repeat(70)}`);
  console.log(`Total games: ${totalGames}`);
  console.log(`\nOverall Results:`);
  console.log(`  Agent wins: ${agentWins} (${((agentWins / totalGames) * 100).toFixed(1)}%)`);
  console.log(`  Stockfish wins: ${stockfishWins} (${((stockfishWins / totalGames) * 100).toFixed(1)}%)`);
  console.log(`  Draws: ${draws} (${((draws / totalGames) * 100).toFixed(1)}%)`);
  
  console.log(`\nAs White:`);
  console.log(`  Wins: ${stats.agentAsWhite.wins}, Losses: ${stats.agentAsWhite.losses}, Draws: ${stats.agentAsWhite.draws}`);
  
  console.log(`\nAs Black:`);
  console.log(`  Wins: ${stats.agentAsBlack.wins}, Losses: ${stats.agentAsBlack.losses}, Draws: ${stats.agentAsBlack.draws}`);
  
  const avgMoves = results.reduce((sum, r) => sum + r.moveCount, 0) / results.length;
  console.log(`\nAverage moves per game: ${avgMoves.toFixed(1)}`);
  console.log(`${"=".repeat(70)}`);
}

function saveResults(
  results: GameResult[],
  stats: GameStats,
  totalGames: number,
  stockfishDepth: number,
  apiDelaySeconds: number,
  useCCP: boolean,
  agentTimeoutSeconds: number
): void {
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const ccpSuffix = useCCP ? "ccp" : "no-ccp";
  const filename = `benchmark_results_${model.replace(/[/:]/g, "_")}_${ccpSuffix}_${timestamp}.json`;
  
  const agentWins = stats.agentAsWhite.wins + stats.agentAsBlack.wins;
  const stockfishWins = stats.agentAsWhite.losses + stats.agentAsBlack.losses;
  const draws = stats.agentAsWhite.draws + stats.agentAsBlack.draws;

  fs.writeFileSync(
    filename,
    JSON.stringify(
      {
        summary: {
          totalGames,
          completedGames: results.length,
          agentWins,
          stockfishWins,
          draws,
          stockfishDepth,
          apiDelaySeconds,
          agentTimeoutSeconds,
          model: model,
          provider: provider,
          ccpEnabled: useCCP,
          stats,
        },
        games: results,
      },
      null,
      2
    )
  );
  
  console.log(`\nResults saved to: ${filename}`);
}

// Run the benchmark
const games = parseInt(filteredArgs[0]) || 5;
const depth = parseInt(filteredArgs[1]) || 15;
const apiDelay = parseInt(filteredArgs[2]) || 1;
const agentTimeout = parseInt(filteredArgs[3]) || 60;
const stockfishElo = parseInt(filteredArgs[4]) || 1000;

runBenchmark(games, depth, apiDelay, useCCP, agentTimeout)
  .then(() => {
    console.log("\n✅ Benchmark completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Benchmark failed:", error);
    process.exit(1);
  });

export { playGame, runBenchmark };