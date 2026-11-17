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

/** **bold** inside a line. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

/** Release notes written in CHANGELOG.md's style (an update's notes come in this form). */
export function NotesText({ text }: { text: string }) {
  return <ReleaseNotes r={{ version: "", lines: text.split("\n").map((l) => l.trimEnd()) }} bare />;
}

function ReleaseNotes({ r, bare = false }: { r: Release; bare?: boolean }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {!bare && <Text fw={800} size="lg" mb={4}>Castle {versionLabel(r.version)} {r.version.includes("-") && <Badge size="xs" variant="light" color="orange" ml={4}>Beta</Badge>}</Text>}
      {r.lines.map((l, i) =>
        l.startsWith("### ") ? <Text key={i} fw={700} size="sm" mt={10} mb={2}>{l.slice(4)}</Text>
        : l.startsWith("- ") ? <Text key={i} size="sm" pl={14} style={{ textIndent: -10 }} mb={3}>• {inline(l.slice(2))}</Text>
        : l ? <Text key={i} size="sm" c="dimmed" mb={4}>{inline(l)}</Text> : null)}
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
