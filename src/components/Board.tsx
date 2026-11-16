import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawBrushes, DrawShape } from "chessground/draw";
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
  /** 0–1: how solid the arrow is drawn. */
  opacity?: number;
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
  /** Free boards: the piece placement (FEN board part) after every change, drops off the board included. */
  onPlacement?: (placement: string) => void;
  /** Takes clicks and drags across squares instead of moving pieces (placing pieces by hand). */
  onPaint?: (square: string, start: boolean) => void;
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
  // Each coordinate sits on its own edge square and takes the other square colour.
  // From White's side a1 is dark, so odd ranks and files are written light; from
  // Black's side the edge squares start light.
  let css = `cg-board{background-color:${t.light};background-image:conic-gradient(${t.dark} 90deg,${t.light} 90deg 180deg,${t.dark} 180deg 270deg,${t.light} 270deg);background-size:25% 25%;}
.cg-wrap coords coord{color:${t.dark};text-shadow:0 0 2px ${t.light},0 0 2px ${t.light},0 0 1px ${t.light};}
.cg-wrap coords:not(.black) coord:nth-child(odd),.cg-wrap coords.black coord:nth-child(even){color:${t.light};text-shadow:0 0 2px ${t.dark},0 0 2px ${t.dark},0 0 1px ${t.dark};}\n`;
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
const BRUSH_LOOK: Record<string, { color: string; opacity: number; lineWidth: number }> = {
  green: { color: "#15781B", opacity: 1, lineWidth: 10 },
  red: { color: "#882020", opacity: 1, lineWidth: 10 },
  blue: { color: "#003088", opacity: 1, lineWidth: 10 },
  yellow: { color: "#e68f00", opacity: 1, lineWidth: 10 },
  paleBlue: { color: "#003088", opacity: 0.4, lineWidth: 15 },
  paleGreen: { color: "#15781B", opacity: 0.4, lineWidth: 15 },
  paleRed: { color: "#882020", opacity: 0.4, lineWidth: 15 },
  paleGrey: { color: "#4a4a4a", opacity: 0.35, lineWidth: 15 },
};

/**
 * Chessground takes an arrow's opacity from its brush, so engine arrows that fade
 * by rank use one brush per colour and opacity step (tenths, 0.1 to 1).
 */
const OPACITY_BRUSHES: Record<string, { key: string; color: string; opacity: number; lineWidth: number }> = (() => {
  const out: Record<string, { key: string; color: string; opacity: number; lineWidth: number }> = {};
  for (const [name, look] of Object.entries(BRUSH_LOOK)) {
    out[name] = { key: name, ...look };
    for (let i = 1; i <= 10; i++) out[`${name}@${i}`] = { key: `${name}o${i}`, color: look.color, opacity: i / 10, lineWidth: look.lineWidth };
  }
  return out;
})();
const opacityBrush = (brush: string, opacity: number) => `${BRUSH_LOOK[brush] ? brush : "paleBlue"}@${Math.max(1, Math.min(10, Math.round(opacity * 10)))}`;

const fileRank = (sq: string): [number, number] => [sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 49];

/** Whether an arrow between two squares is a knight's jump. */
export function isKnightJump(from: string, to: string): boolean {
  const [f1, r1] = fileRank(from), [f2, r2] = fileRank(to);
  const df = Math.abs(f1 - f2), dr = Math.abs(r1 - r2);
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

/**
 * An L-shaped arrow for a knight's jump, as chessground custom SVG. The SVG is
 * placed on the origin square's centre, 100 units to a square: it runs two
 * squares along the long side, turns, and ends with chessground's arrowhead.
 */
function knightSvg(from: string, to: string, orientation: Color, color: string, opacity: number, lineWidth: number): string {
  const [f1, r1] = fileRank(from), [f2, r2] = fileRank(to);
  const flip = orientation === "white" ? 1 : -1;
  const dx = (f2 - f1) * flip * 100, dy = -(r2 - r1) * flip * 100;
  const corner = Math.abs(dy) > Math.abs(dx) ? [0, dy] : [dx, 0];
  const w = (lineWidth / 64) * 100;
  // The last leg is axis-aligned: unit vector from the corner to the target.
  const ux = Math.sign(dx - corner[0]), uy = Math.sign(dy - corner[1]);
  const margin = (10 / 64) * 100;
  const end = [dx - ux * margin, dy - uy * margin];
  const base = [end[0] - ux * 2.05 * w, end[1] - uy * 2.05 * w];
  const tip = [end[0] + ux * 0.95 * w, end[1] + uy * 0.95 * w];
  const px = -uy, py = ux;
  const head = [
    [base[0] + px * 2 * w, base[1] + py * 2 * w],
    tip,
    [base[0] - px * 2 * w, base[1] - py * 2 * w],
  ].map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
  // The shapes layer draws at 60% opacity; custom SVG has no such layer, so apply it here.
  const o = (opacity * 0.6).toFixed(3);
  // Custom SVG is anchored at the square's top-left corner: move to its centre.
  return `<g transform="translate(50,50)" opacity="${o}"><polyline points="0,0 ${corner[0]},${corner[1]} ${base[0].toFixed(1)},${base[1].toFixed(1)}" fill="none" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${head}" fill="${color}"/></g>`;
}

/** A user drawing as chessground shapes: knight jumps become L-shaped custom SVG with no brush. */
function toCgShape(s: Shape, orientation: Color): DrawShape {
  if (s.from !== s.to && isKnightJump(s.from, s.to)) {
    const b = BRUSH_LOOK[s.color];
    return { orig: s.from as Key, dest: s.to as Key, customSvg: { html: knightSvg(s.from, s.to, orientation, b.color, b.opacity, b.lineWidth) } };
  }
  return { orig: s.from as Key, dest: s.from === s.to ? undefined : (s.to as Key), brush: s.color };
}

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
  const appliedOrientation = useRef<Color>();
  /** What the user has drawn on this position, in Castle's own form. */
  const drawn = useRef<Shape[]>([]);

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
      draggable: { showGhost: true, deleteOnDropOff: !!p.free },
      autoCastle: !p.free,
      drawable: { enabled: !p.readOnly, visible: true, eraseOnClick: !p.onShapes, brushes: OPACITY_BRUSHES as unknown as DrawBrushes },
    };
  };

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const cg = Chessground(el.current, {
      ...config(),
      events: {
        select: (key) => latest.current.onSelect?.(key),
        change: () => {
          const p = latest.current;
          if (p.free && p.onPlacement && api.current) {
            const placement = api.current.getFen();
            appliedFen.current = undefined;
            p.onPlacement(placement);
          }
        },
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
          // Knight drawings are held as brushless custom SVG, so chessground cannot
          // tell that drawing the same arrow again should erase it: work that out here.
          const prev = drawn.current;
          const out: Shape[] = [];
          for (const s of shapes) {
            const to = s.dest ?? s.orig;
            if (s.customSvg && !s.brush) {
              const kept = prev.find((p) => p.from === s.orig && p.to === to);
              if (kept) out.push(kept);
              continue;
            }
            if (!BRUSHES.includes(s.brush as ShapeColor)) continue;
            const shape: Shape = { from: s.orig, to, color: s.brush as ShapeColor };
            const before = prev.find((p) => p.from === shape.from && p.to === shape.to);
            if (before && isKnightJump(shape.from, shape.to) && shape.from !== shape.to && before.color === shape.color) continue;
            out.push(shape);
          }
          drawn.current = out;
          api.current?.setShapes(out.map((s) => toCgShape(s, latest.current.orientation ?? "white")));
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
    const orientation = p.orientation ?? "white";
    const turned = appliedOrientation.current !== undefined && appliedOrientation.current !== orientation;
    appliedOrientation.current = orientation;
    if (p.onShapes && (fenChanged || appliedShapes.current !== p.shapes)) {
      drawn.current = p.shapes ?? [];
      cg.setShapes(drawn.current.map((s) => toCgShape(s, orientation)));
    } else if (!p.onShapes && fenChanged) {
      drawn.current = [];
    } else if (turned) {
      // The L of a knight arrow is drawn in screen space, so it is redrawn on a flip.
      cg.setShapes(drawn.current.map((s) => toCgShape(s, orientation)));
    }
    appliedShapes.current = p.shapes;
    const auto: DrawShape[] = (p.arrows ?? []).map((a) => {
      const brush = a.color ?? "paleBlue";
      const look = BRUSH_LOOK[brush] ?? BRUSH_LOOK.paleBlue;
      const lineWidth = Math.round(6 + 6 * (a.strength ?? 1));
      const opacity = a.opacity ?? look.opacity;
      if (isKnightJump(a.from, a.to)) {
        return { orig: a.from as Key, dest: a.to as Key, customSvg: { html: knightSvg(a.from, a.to, orientation, look.color, opacity, lineWidth) } };
      }
      return { orig: a.from as Key, dest: a.to as Key, brush: a.opacity === undefined ? brush : opacityBrush(brush, opacity), modifiers: { lineWidth } };
    });
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

  const squareAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    let file = Math.floor(((e.clientX - r.left) / r.width) * 8), rank = 7 - Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (orientation === "black") { file = 7 - file; rank = 7 - rank; }
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return undefined;
    return makeSquare(rank * 8 + file);
  };
  const painting = useRef<string>();

  return (
    <div className="board-area">
      <div className={"board-fit" + (pockets ? " with-pockets" : "")}>
        {pocketRow(top)}
        <div className={"board-square" + (settings.perspective ? " perspective" : "")}>
          <div ref={el} className="cg-wrap" />
          {drop && <div className="drop-layer" onClick={dropOn} />}
          {props.onPaint && (
            <div className="paint-layer"
              onMouseDown={(e) => { const sq = squareAt(e); if (!sq) return; painting.current = sq; props.onPaint!(sq, true); }}
              onMouseMove={(e) => { if (!painting.current || !(e.buttons & 1)) { painting.current = undefined; return; } const sq = squareAt(e); if (sq && sq !== painting.current) { painting.current = sq; props.onPaint!(sq, false); } }}
              onMouseUp={() => { painting.current = undefined; }}
              onContextMenu={(e) => e.preventDefault()} />
          )}
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
