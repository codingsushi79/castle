import { ActionIcon, Button, Group, Text, Tooltip } from "@mantine/core";
import { IconBulb, IconMessageCircle, IconMessageCircleOff, IconVolume, IconVolumeOff } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { Personality } from "../lib/personalities";
import { usePlay } from "../lib/play";

/** A personality's face: their initials on their colour. */
export function Avatar({ p, size = 34 }: { p: Pick<Personality, "name" | "color">; size?: number }) {
  const initials = p.name.replace(/^(The|Coach) /, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, background: p.color, fontSize: size * 0.4 }} aria-hidden>
      {initials}
    </span>
  );
}

/** What the opponent says during a game, with hints from coaches. */
export function CoachChat() {
  const p = usePlay();
  const persona = p.persona;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [p.chat.length]);
  if (!persona) return null;
  const myTurn = p.phase === "playing" && !p.thinking && p.tree.last.turn === p.humanColor;
  return (
    <div className="coach-chat">
      <Group gap={8} wrap="nowrap" className="coach-chat-head">
        <Avatar p={persona} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} size="sm" truncate>{persona.name}</Text>
          <Text size="xs" c="dimmed" truncate>{persona.style}{p.opponentElo ? ` · plays at ${Math.round(p.opponentElo)}` : ""}</Text>
        </div>
        <Tooltip label={p.talk ? "Mute chat" : "Let them talk"}>
          <ActionIcon variant="subtle" color="gray" onClick={() => p.patch({ talk: !p.talk })}>{p.talk ? <IconMessageCircle size={16} /> : <IconMessageCircleOff size={16} />}</ActionIcon>
        </Tooltip>
        {typeof speechSynthesis !== "undefined" && (
          <Tooltip label={p.speak ? "Stop reading aloud" : "Read aloud"}>
            <ActionIcon variant="subtle" color="gray" onClick={() => p.patch({ speak: !p.speak })}>{p.speak ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}</ActionIcon>
          </Tooltip>
        )}
      </Group>
      <div className="coach-chat-lines">
        {!p.talk && !p.chat.length && <Text size="xs" c="dimmed" ta="center" py={8}>Chat is off.</Text>}
        {p.talk && !p.coaching && p.phase === "playing" && !p.chat.length && <Text size="xs" c="dimmed" ta="center" py={8}>Comments need standard chess.</Text>}
        {p.chat.map((m) => (
          <div key={m.id} className={"bubble " + m.who}>{m.text}</div>
        ))}
        <div ref={end} />
      </div>
      {persona.coach && p.phase === "playing" && (
        <Button size="xs" variant="light" leftSection={<IconBulb size={14} />} disabled={!myTurn || !p.coaching} onClick={() => p.askHint()}>
          {p.hint?.arrow ? "That's my hint" : p.hint ? "Show me the move" : "Hint"}
        </Button>
      )}
    </div>
  );
}
