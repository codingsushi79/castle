import { Badge, Modal, Text } from "@mantine/core";
import { getVersion } from "@tauri-apps/api/app";
import { Fragment, ReactNode, useEffect } from "react";
import { create } from "zustand";
import changelog from "../../CHANGELOG.md?raw";
import { isTauri, load, save } from "../lib/storage";
import { versionLabel } from "../lib/updates";

/** One release from CHANGELOG.md: "## 2.3.0-1" followed by text, "### " sections and "- " items. */
interface Release { version: string; lines: string[] }

const RELEASES: Release[] = changelog.split(/^## /m).slice(1).map((chunk) => {
  const [head, ...rest] = chunk.split("\n");
  return { version: head.trim(), lines: rest.map((l) => l.trimEnd()).filter((l, i, a) => l || (a[i - 1] && a[i + 1])) };
});

/** "2.3.0-1" → [2, 3, 0, 1]; a release (no suffix) sorts after its betas. */
const parts = (v: string) => {
  const [base, pre] = v.split("-");
  return [...base.split(".").map(Number), pre === undefined ? Infinity : Number(pre)];
};
const newer = (a: string, b: string) => {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const useWhatsNew = create<{ open: boolean; since?: string }>(() => ({ open: false }));
export const openWhatsNew = () => useWhatsNew.setState({ open: true, since: undefined });

/** Inline Markdown: **bold**, *italic* or _italic_, `code`, and [links](https://…). */
export function inline(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (t.startsWith("**") || t.startsWith("__")) out.push(<b key={k++}>{inline(t.slice(2, -2))}</b>);
    else if (t.startsWith("`")) out.push(<code key={k++} style={{ fontSize: "0.92em", padding: "0 4px", borderRadius: 4, background: "var(--bg-raised)" }}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(<a key={k++} href={href} target="_blank" rel="noreferrer" style={{ color: "var(--mantine-primary-color-filled)" }}>{label}</a>);
    } else out.push(<i key={k++}>{inline(t.slice(1, -1))}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return out;
}

/**
 * A small Markdown renderer for release notes: headings (# to ####), bullet
 * lists (-, *, +, indented ones too), numbered lists, quotes, rules and
 * paragraphs, with inline formatting. Anything else shows as plain text.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<Text key={blocks.length} size="sm" c="dimmed" mb={6}>{inline(para.join(" "))}</Text>);
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) {
      flush();
      const level = heading[1].length;
      blocks.push(<Text key={blocks.length} fw={level <= 2 ? 800 : 700} size={level <= 2 ? "md" : "sm"} mt={level <= 2 ? 12 : 10} mb={3}>{inline(heading[2])}</Text>);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={blocks.length} style={{ border: 0, borderTop: "1px solid var(--border)", margin: "8px 0" }} />);
    } else if (bullet || numbered) {
      flush();
      const indent = Math.floor(((bullet ?? numbered)![1].length) / 2);
      const marker = bullet ? (indent ? "◦" : "•") : `${numbered![2]}.`;
      const body = bullet ? bullet[2] : numbered![3];
      blocks.push(
        <Text key={blocks.length} size="sm" mb={3} style={{ display: "flex", gap: 6, paddingLeft: 4 + indent * 16 }}>
          <span style={{ flex: "none", minWidth: bullet ? 8 : 16, opacity: 0.8 }}>{marker}</span><span>{inline(body)}</span>
        </Text>,
      );
    } else if (line.trim().startsWith(">")) {
      flush();
      blocks.push(<Text key={blocks.length} size="sm" c="dimmed" mb={4} pl={10} style={{ borderLeft: "3px solid var(--border)" }}>{inline(line.trim().replace(/^>\s?/, ""))}</Text>);
    } else para.push(line.trim());
  }
  flush();
  return <>{blocks}</>;
}

/** An update's release notes (Markdown, as in CHANGELOG.md). */
export function NotesText({ text }: { text: string }) {
  return <Markdown text={text} />;
}

function ReleaseNotes({ r }: { r: Release }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <Text fw={800} size="lg" mb={4}>Castle {versionLabel(r.version)} {r.version.includes("-") && <Badge size="xs" variant="light" color="orange" ml={4}>Beta</Badge>}</Text>
      <Markdown text={r.lines.join("\n")} />
    </div>
  );
}

/** The changelog, shown once after Castle updates and from Settings at any time. */
export function WhatsNew() {
  const { open, since } = useWhatsNew();
  useEffect(() => {
    if (!isTauri) return;
    getVersion().then((version) => {
      const seen = load<string>("seenVersion", "");
      save("seenVersion", version);
      // A fresh install has no settings yet; anyone else has just updated.
      const updated = seen ? newer(version, seen) : load("settings", null) !== null;
      const at = RELEASES.findIndex((r) => r.version === version);
      // Coming from a version older than this window: show just the newest release.
      if (updated && at >= 0) useWhatsNew.setState({ open: true, since: seen || RELEASES[at + 1]?.version || "0.0.0" });
    }).catch(() => {});
  }, []);
  // After an update: the releases since the last one seen. From Settings: all of them.
  const shown = since ? RELEASES.filter((r) => newer(r.version, since)).slice(0, 4) : RELEASES;
  return (
    <Modal opened={open} onClose={() => useWhatsNew.setState({ open: false })} title={<Text fw={800}>What's new in Castle</Text>} size="lg">
      <div style={{ maxHeight: "65vh", overflowY: "auto", paddingRight: 6 }}>
        {(shown.length ? shown : RELEASES.slice(0, 1)).map((r) => <ReleaseNotes key={r.version} r={r} />)}
      </div>
    </Modal>
  );
}
