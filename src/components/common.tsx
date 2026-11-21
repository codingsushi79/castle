import { ActionIcon, Group, Text, Tooltip } from "@mantine/core";
import { IconArrowsUpDown, IconChevronLeft, IconChevronRight, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-react";
import { Fragment, ReactNode, useEffect, useRef } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import { Color, GameTree, GNode, NAGS, Score, scoreShort, winPercent } from "../lib/chess";
import { useTree } from "../lib/store";
import { clockText } from "../lib/storage";
import { PlayerAvatar } from "./PlayerAvatar";

export function Panel({ title, right, children, grow, pad = true }: { title?: ReactNode; right?: ReactNode; children: ReactNode; grow?: boolean; pad?: boolean }) {
  return (
    <section className={"panel" + (grow ? " grow" : "")}>
      {title && (
        <header>
          <span>{title}</span>
          {right}
        </header>
      )}
      <div className={"panel-body" + (pad ? " pad" : "")}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <Text fw={600}>{title}</Text>
      {children && <Text size="sm" c="dimmed" maw={420} ta="center" component="div">{children}</Text>}
    </div>
  );
}

export function EvalBar({ score, flipped }: { score?: Score; flipped?: boolean }) {
  const white = score ? winPercent(score) : 50;
  return (
    <div className={"evalbar" + (flipped ? " flipped" : "")}>
      <div className="fill" style={{ height: `${white}%` }} />
      {score && <span className={white >= 50 ? "w" : "b"}>{scoreShort(score)}</span>}
    </div>
  );
}

export function ResultBar({ white, draws, black }: { white: number; draws: number; black: number }) {
  const total = Math.max(1, white + draws + black);
  const seg = (n: number, cls: string) => {
    const share = (n / total) * 100;
    return share > 0 ? <div className={cls} style={{ width: `${share}%` }}>{share >= 16 ? `${Math.round(share)}%` : ""}</div> : null;
  };
  return (
    <div className="resultbar">
      {seg(white, "w")}
      {seg(draws, "d")}
      {seg(black, "b")}
    </div>
  );
}

/** A player's name, rating, clock and material beside the board. With `guest` (a Castle Online player), their profile picture replaces the coloured dot. */
export function PlayerStrip({ name, color, detail, clock, active, material, guest }: { name: string; color: Color; detail?: string; clock?: number; active?: boolean; material?: number; guest?: string | null }) {
  const dot = <span className={"dot " + color} />;
  return (
    <div className="strip">
      {guest ? <PlayerAvatar guest={guest} size={24} ring={color} fallback={dot} /> : dot}
      <Text fw={600} truncate>{name}</Text>
      {detail && <Text size="sm" c="dimmed">{detail}</Text>}
      {!!material && material > 0 && <Text size="xs" c="dimmed">+{material}</Text>}
      <span style={{ flex: 1 }} />
      {active && clock === undefined && <span className="thinking">•••</span>}
      {clock !== undefined && <span className={"clock" + (active ? " active" : "") + (active && clock < 20 ? " low" : "")}>{clockText(clock)}</span>}
    </div>
  );
}

export function NavBar({ tree, onFlip, children }: { tree: GameTree; onFlip?: () => void; children?: ReactNode }) {
  useTree(tree);
  const b = (label: string, icon: ReactNode, fn: () => void, disabled: boolean) => (
    <Tooltip label={label} openDelay={500}>
      <ActionIcon variant="subtle" color="gray" onClick={fn} disabled={disabled}>{icon}</ActionIcon>
    </Tooltip>
  );
  return (
    <Group gap={4} className="navbar">
      {b("Start", <IconPlayerSkipBack size={16} />, () => tree.toStart(), !tree.current.parent)}
      {b("Back", <IconChevronLeft size={18} />, () => tree.back(), !tree.current.parent)}
      {b("Forward", <IconChevronRight size={18} />, () => tree.forward(), !tree.current.children.length)}
      {b("End", <IconPlayerSkipForward size={16} />, () => tree.toEnd(), !tree.current.children.length)}
      {onFlip && b("Flip board", <IconArrowsUpDown size={16} />, onFlip, false)}
      {children}
    </Group>
  );
}

const nagClass = (nag?: number) => (nag === 4 ? "blunder" : nag === 2 ? "mistake" : nag === 6 ? "inaccuracy" : nag === 1 || nag === 3 ? "good" : "");

/** The game's moves with variations and comments as wrapping clickable text. */
export function MoveList({ tree, editable = true, onContext }: { tree: GameTree; editable?: boolean; onContext?: (node: GNode, e: React.MouseEvent) => void }) {
  useTree(tree);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(".move.current")?.scrollIntoView({ block: "nearest" });
  }, [tree.current]);

  const move = (node: GNode, numbered: boolean, depth: number) => (
    <Fragment key={node.id}>
      <span
        className={`move ${tree.current === node ? "current" : ""} ${nagClass(node.nag)} ${depth ? "side" : ""}`}
        onClick={() => tree.go(node)}
        onContextMenu={(e) => {
          if (!editable) return;
          e.preventDefault();
          onContext?.(node, e);
        }}
      >
        {(node.parent?.turn === "white" || numbered) && <i>{node.numberLabel} </i>}
        {node.san}
        {node.nag ? NAGS[node.nag] : ""}
      </span>
      {node.comment && <span className="comment">{node.comment}</span>}
    </Fragment>
  );

  const line = (start: GNode, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let parent = start;
    let needNumber = true;
    while (parent.children[0]) {
      const main = parent.children[0];
      out.push(move(main, needNumber, depth));
      needNumber = !!main.comment;
      for (const alt of parent.children.slice(1)) {
        out.push(
          <span key={"v" + alt.id} className="variation">
            ({move(alt, true, depth + 1)}
            {line(alt, depth + 1)})
          </span>,
        );
        needNumber = true;
      }
      parent = main;
    }
    return out;
  };

  const nodes = line(tree.root, 0);
  return (
    <div className="movelist" ref={ref}>
      {tree.root.comment && <span className="comment">{tree.root.comment}</span>}
      {nodes.length ? nodes : <Text c="dimmed" size="sm" ta="center" py="lg">No moves yet</Text>}
    </div>
  );
}

/** White's winning chances across the game; click to jump to a move. */
export function EvalChart({ tree, height = 60 }: { tree: GameTree; height?: number }) {
  useTree(tree);
  const nodes = [tree.root, ...tree.mainline];
  const data = nodes.map((n, i) => ({ i, win: n.eval ? winPercent(n.eval) : undefined }));
  const current = nodes.indexOf(tree.current);
  return (
    <div className="evalchart" style={{ height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} onClick={(e) => typeof e?.activeTooltipIndex === "number" && tree.go(nodes[e.activeTooltipIndex])}>
          <YAxis domain={[0, 100]} hide />
          <Area type="monotone" dataKey="win" stroke="none" fill="#e8e8e8" fillOpacity={0.85} connectNulls isAnimationActive={false} />
          <ReferenceLine y={50} stroke="#888" strokeDasharray="3 3" />
          {current >= 0 && <ReferenceLine x={current} stroke="var(--mantine-primary-color-filled)" strokeWidth={2} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Stat({ label, value, icon, color }: { label: string; value: ReactNode; icon?: ReactNode; color?: string }) {
  return (
    <div className="stat">
      {icon && <span style={{ color }}>{icon}</span>}
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}
