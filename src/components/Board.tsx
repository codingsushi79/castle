import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import "chessground/assets/chessground.base.css";
import { Crazyhouse } from "chessops/variant";
import type { Move, Role, Rules } from "chessops/types";
import { makeSquare, parseSquare } from "chessops/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, destsOf, positionOf, Shape, ShapeColor, tryPosition, turnOf } from "../lib/chess";
import { boardColors, useApp } from "../lib/store";

export interface AutoArrow {
  from: string;
  to: string;
  color?: string;
  strength?: number;
}

interface Props {
  fen: string;
  rules?: Rules;
  chess960?: boolean;
  orientation?: Color;
  /** Which side the mouse may move. Omit for a read-only board. */
  movable?: Color | "both";
  lastMove?: [string, string];
  shapes?: Shape[];
  arrows?: AutoArrow[];
  hint?: string;
  onMove?: (move: Move) => void;
  onShapes?: (shapes: Shape[]) => void;
  /** The side that may queue a move while the opponent thinks. */
  premove?: { color: Color; onSet: (from: string, to: string) => void; onUnset: () => void };
  /** Free placement: any piece can be dragged anywhere (used by the trainers and editor). */
  free?: boolean;
  onFreeMove?: (from: string, to: string) => void;
  onSelect?: (square: string) => void;
  highlight?: Record<string, string>;
  /** A board for display only: no moving and no drawing (small previews). */
  readOnly?: boolean;
}

const styleId = "castle-board-style";

/** Board colours and the piece set are plain CSS, regenerated when the settings change. */
function applyLook(theme: string, set: string) {
  const t = boardColors(theme);
  const names: Record<string, string> = { pawn: "P", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K" };
  let css = `cg-board{background-color:${t.light};background-image:conic-gradient(${t.dark} 90deg,${t.light} 90deg 180deg,${t.dark} 180deg 270deg,${t.light} 270deg);background-size:25% 25%;}
.cg-wrap coords{color:${t.dark};} .cg-wrap coords.ranks coord:nth-child(odd),.cg-wrap coords.files coord:nth-child(even){color:${t.light};}
.cg-wrap.orientation-black coords.ranks coord:nth-child(odd),.cg-wrap.orientation-black coords.files coord:nth-child(even){color:${t.dark};}
.cg-wrap.orientation-black coords.ranks coord:nth-child(even),.cg-wrap.orientation-black coords.files coord:nth-child(odd){color:${t.light};}\n`;
  for (const [role, letter] of Object.entries(names)) {
    for (const color of ["white", "black"]) {
      css += `.cg-wrap piece.${role}.${color},.piece-img.${role}.${color}{background-image:url(/pieces/${set}/${color[0]}${letter}.svg);}\n`;
    }
  }
  let el = document.getElementById(styleId);
  if (!el) {
    el = document.createElement("style");
    el.id = styleId;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function PieceImg({ role, color, size = 28 }: { role: string; color: Color; size?: number }) {
  return <span className={`piece-img ${role} ${color}`} style={{ width: size, height: size }} />;
}

const BRUSHES: ShapeColor[] = ["green", "red", "blue", "yellow"];

export function Board(props: Props) {
  const { fen, rules = "chess", chess960 = false, orientation = "white", movable, lastMove } = props;
  const settings = useApp((s) => s.settings);
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api>();
  const latest = useRef(props);
  latest.current = props;
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const [promotion, setPromotion] = useState<{ from: string; to: string }>();
  const [drop, setDrop] = useState<Role>();
  const appliedFen = useRef<string>();
  const appliedShapes = useRef<Shape[] | undefined>();

  const pos = useMemo(() => tryPosition(fen, rules), [fen, rules]);
  const turn = turnOf(fen);

  useEffect(() => applyLook(settings.boardTheme, settings.pieceSet), [settings.boardTheme, settings.pieceSet, settings.customLight, settings.customDark]);

  // Everything here reads the latest props: this runs from chessground's own event
  // handlers too, which were created with the first render's closures.
  const config = (): Config => {
    const p = latest.current;
    const pos = tryPosition(p.fen, p.rules ?? "chess");
    const turn = turnOf(p.fen);
    const chess960 = !!p.chess960;
    const settings = latestSettings.current;
    const canMove = p.movable && pos && !pos.isEnd() && (p.movable === "both" || p.movable === turn);
    // The board is never created "view only": chessground binds its mouse handlers
    // once, at creation, and a view-only board would stay dead when it later
    // becomes the user's turn. Whether pieces move is decided by movable.color.
    return {
      ...(appliedFen.current === p.fen ? {} : { fen: p.fen.split(" ")[0] }),
      orientation: p.orientation ?? "white",
      turnColor: turn,
      check: pos?.isCheck() ? turn : false,
      lastMove: p.lastMove as Key[] | undefined,
      coordinates: settings.coords,
      viewOnly: !!p.readOnly,
      disableContextMenu: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true, custom: p.highlight ? new Map(Object.entries(p.highlight)) as Map<Key, string> : undefined },
      selectable: { enabled: true },
      trustAllEvents: import.meta.env.DEV,
      movable: p.free
        ? { free: true, color: "both", showDests: false }
        : { free: false, color: canMove ? turn : undefined, dests: canMove && pos ? (destsOf(pos, chess960) as Map<Key, Key[]>) : new Map(), showDests: settings.dests },
      premovable: { enabled: !!p.premove, showDests: settings.dests, castle: true, events: { set: (o, d) => latest.current.premove?.onSet(o, d), unset: () => latest.current.premove?.onUnset() } },
      draggable: { showGhost: true },
      drawable: { enabled: !p.readOnly, visible: true, eraseOnClick: !p.onShapes },
    };
  };

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const cg = Chessground(el.current, {
      ...config(),
      events: {
        select: (key) => latest.current.onSelect?.(key),
      },
      movable: {
        ...config().movable,
        events: {
          after: (orig, dest) => {
            const p = latest.current;
            appliedFen.current = undefined;
            if (p.free) return p.onFreeMove?.(orig, dest);
            const position = tryPosition(p.fen, p.rules ?? "chess");
            const from = parseSquare(orig), to = parseSquare(dest);
            if (!position || from === undefined || to === undefined) return;
            const piece = position.board.get(from);
            const lastRank = to >> 3 === (position.turn === "white" ? 7 : 0);
            if (piece?.role === "pawn" && lastRank) return setPromotion({ from: orig, to: dest });
            p.onMove?.({ from, to });
            setTimeout(sync, 0);
          },
        },
      },
      drawable: {
        ...config().drawable,
        onChange: (shapes) => {
          const out: Shape[] = shapes
            .filter((s) => BRUSHES.includes(s.brush as ShapeColor))
            .map((s) => ({ from: s.orig, to: s.dest ?? s.orig, color: s.brush as ShapeColor }));
          latest.current.onShapes?.(out);
        },
      },
    });
    api.current = cg;
    if (import.meta.env.DEV) (window as any).__cg = cg;
    appliedFen.current = latest.current.fen;
    return () => {
      cg.destroy();
      api.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = () => {
    const cg = api.current;
    if (!cg) return;
    const p = latest.current;
    const fenChanged = appliedFen.current !== p.fen;
    cg.set(config());
    appliedFen.current = p.fen;
    // Saved drawings belong to a position: restore them when the position or the
    // list changes. Boards without saved drawings keep what the user drew until the
    // next move (chessground clears drawings itself when the position changes).
    if (p.onShapes && (fenChanged || appliedShapes.current !== p.shapes)) {
      cg.setShapes((p.shapes ?? []).map((s) => ({ orig: s.from as Key, dest: s.from === s.to ? undefined : (s.to as Key), brush: s.color })));
    }
    appliedShapes.current = p.shapes;
    const auto: DrawShape[] = (p.arrows ?? []).map((a) => ({
      orig: a.from as Key,
      dest: a.to as Key,
      brush: a.color ?? "paleBlue",
      modifiers: { lineWidth: 6 + 6 * (a.strength ?? 1) },
    }));
    if (p.hint) auto.push({ orig: p.hint as Key, brush: "green" });
    cg.setAutoShapes(auto);
  };

  useEffect(sync);

  const promote = (role: Role | undefined) => {
    appliedFen.current = undefined;
    const pr = promotion;
    setPromotion(undefined);
    if (pr && role) props.onMove?.({ from: parseSquare(pr.from)!, to: parseSquare(pr.to)!, promotion: role });
    setTimeout(sync, 0);
  };

  // Crazyhouse: click a pocket piece, then a square.
  const pockets = pos instanceof Crazyhouse ? pos.pockets : undefined;
  const dropOn = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    let file = Math.floor(((e.clientX - r.left) / r.width) * 8), rank = 7 - Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (orientation === "black") { file = 7 - file; rank = 7 - rank; }
    const role = drop;
    setDrop(undefined);
    appliedFen.current = undefined;
    if (role) props.onMove?.({ role, to: rank * 8 + file });
    setTimeout(sync, 0);
  };
  const pocketRow = (color: Color) =>
    pockets && (
      <div className="pocket">
        {(["pawn", "knight", "bishop", "rook", "queen"] as Role[]).map((role) => {
          const n = pockets[color][role];
          const usable = movable && (movable === "both" || movable === color) && turn === color && n > 0;
          return (
            <button key={role} disabled={!usable} className={drop === role && turn === color ? "on" : ""} onClick={() => setDrop(drop === role ? undefined : role)}>
              <PieceImg role={role} color={color} size={30} />
              <b>{n}</b>
            </button>
          );
        })}
      </div>
    );
  const top: Color = orientation === "white" ? "black" : "white";

  return (
    <div className="board-area">
      <div className={"board-fit" + (pockets ? " with-pockets" : "")}>
        {pocketRow(top)}
        <div className={"board-square" + (settings.perspective ? " perspective" : "")}>
          <div ref={el} className="cg-wrap" />
          {drop && <div className="drop-layer" onClick={dropOn} />}
          {promotion && (
            <div className="promotion" onClick={() => promote(undefined)}>
              <div onClick={(e) => e.stopPropagation()}>
                {(rules === "antichess" ? ["queen", "knight", "rook", "bishop", "king"] : ["queen", "knight", "rook", "bishop"]).map((role) => (
                  <button key={role} onClick={() => promote(role as Role)}>
                    <PieceImg role={role} color={turn} size={64} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {pocketRow(orientation)}
      </div>
    </div>
  );
}

/** A small read-only board for lists and previews. */
export function MiniBoard({ fen, orientation = "white", lastMove, size = 160 }: { fen: string; orientation?: Color; lastMove?: [string, string]; size?: number }) {
  return (
    <div style={{ width: size, height: size, flex: "none" }}>
      <Board fen={fen} orientation={orientation} lastMove={lastMove} readOnly />
    </div>
  );
}

export const squareName = makeSquare;
export const legalPosition = (fen: string, rules: Rules = "chess") => !!tryPosition(fen, rules) && !!positionOf(fen, rules);
