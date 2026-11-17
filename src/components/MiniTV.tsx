import { ActionIcon, Text, Tooltip } from "@mantine/core";
import { IconArrowsMaximize, IconDeviceTv, IconX } from "@tabler/icons-react";
import { useMemo } from "react";
import { shownClocks, useOnline } from "../lib/online";
import { usePlay } from "../lib/play";
import { clockText } from "../lib/storage";
import { useApp } from "../lib/store";
import { Board } from "./Board";

/** Castle TV in a small window that stays in the corner while you use the rest of Castle. */
export function MiniTV() {
  const o = useOnline();
  const page = useApp((s) => s.page);
  const go = useApp((s) => s.go);
  const g = o.game;
  const tree = useMemo(() => (g ? o.toTree(g) : undefined), [g?.id, g?.ply]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o.tv || !g || o.seat || page === "play" || !tree) return null;
  tree.toEnd();
  const clocks = shownClocks(g, o.receivedAt);
  const line = (c: "white" | "black") => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 4px" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b>{g[c].name}</b> {g[c].rating ?? ""}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{clockText(clocks[c] / 1000)}</span>
    </div>
  );
  return (
    <div className="mini-tv">
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" }}>
        <IconDeviceTv size={13} />
        <Text size="xs" fw={700} style={{ flex: 1 }}>Castle TV</Text>
        <Tooltip label="Open"><ActionIcon size="xs" variant="subtle" color="gray" onClick={() => { if (usePlay.getState().phase === "setup") usePlay.getState().patch({ opponent: "online" }); go("play"); }}><IconArrowsMaximize size={12} /></ActionIcon></Tooltip>
        <Tooltip label="Close"><ActionIcon size="xs" variant="subtle" color="gray" onClick={() => o.leave()}><IconX size={12} /></ActionIcon></Tooltip>
      </div>
      {line("black")}
      <div style={{ width: 220, height: 220 }}><Board fen={tree.fen} rules={tree.rules} chess960={tree.chess960} lastMove={tree.current.lastMove} readOnly /></div>
      {line("white")}
      {g.status === "finished" && <Text size="xs" ta="center" c="dimmed" pb={4}>{g.result} · the next game follows</Text>}
    </div>
  );
}
