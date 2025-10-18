import { LineEval, PositionEval } from "./engine";
import { Chess } from "chess.js";

interface FormatResponse {
    bestmove: string;
    topLine: string;
}

export const formatStockfishPositionEval = (fen: string, data: PositionEval): FormatResponse => {

    const chess = new Chess(fen);

    chess.move(data.bestMove || data.lines[0].pv[0]);

    return {
        bestmove: chess.history({verbose: true})[0].san,
        topLine: formatPrincipalVariation(data.lines[0].pv, fen)
    }


}

export const formatEvaluation = (line: LineEval): string => {
    if (line.mate !== undefined) {
      return `M${line.mate}`;
    }
    if (line.cp !== undefined) {
      const eval1 = line.cp / 100;
      return eval1 > 0 ? `+${eval1.toFixed(2)}` : eval1.toFixed(2);
    }
    return "0.00";
  };

  export const formatPrincipalVariation = 
    (pv: string[], startFen: string): string => {
      const tempGame = new Chess(startFen);
      const moves: string[] = [];

      for (const uciMove of pv.slice(0, 6)) {
        try {
          const move = tempGame.move({
            from: uciMove.slice(0, 2),
            to: uciMove.slice(2, 4),
            promotion: uciMove.length > 4 ? (uciMove[4] as string) : undefined,
          });
          if (move) {
            moves.push(move.san);
          } else {
            break;
          }
        } catch {
          break;
        }
      }

      return moves.join(" ");
    };
  