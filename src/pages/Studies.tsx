import { ActionIcon, Alert, Badge, Button, Group, Loader, Menu, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { IconBook, IconCopy, IconDots, IconLink, IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { MoveList, NavBar, Panel } from "../components/common";
import { copyText } from "../lib/storage";
import { activeTree, useApp, useTree } from "../lib/store";
import { editLink, useStudies, viewLink } from "../lib/studies";

/** Shared studies: chapters of analysis that friends can follow, or edit together. */
export default function StudiesPage() {
  const s = useStudies();
  // A study link pasted into the app (or opened from the web) arrives as an intent.
  const intent = useApp((a) => a.takeIntent);
  useEffect(() => {
    const link = intent("study") as string | undefined;
    if (link) s.openLink(link);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return s.study && s.tree ? <StudyView /> : <StudyHome />;
}

function StudyHome() {
  const s = useStudies();
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string>();
  useEffect(() => { s.refreshMine(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e: any) { useStudies.setState({ status: "error", error: e.message }); } finally { setBusy(undefined); }
  };
  return (
    <div className="page scroll">
      <div style={{ maxWidth: 760, width: "100%", margin: "0 auto" }}>
        <Group mb="md"><IconBook size={26} color="var(--mantine-primary-color-filled)" /><div><Text fw={800} fz={22}>Studies</Text>
          <Text size="sm" c="dimmed">Analysis in chapters, kept online. Share the view link for others to follow, or the edit link to work on it together.</Text></div></Group>
        {s.status === "error" && <Alert color="orange" mb="md" withCloseButton onClose={() => useStudies.setState({ status: "idle", error: undefined })}>{s.error}</Alert>}
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <div className="card">
            <Text fw={700} mb={6}>New study</Text>
            <TextInput placeholder="Title, e.g. My Italian lines" value={title} maxLength={80} onChange={(e) => setTitle(e.currentTarget.value)} />
            <Group gap={6} mt="sm">
              <Button loading={busy === "new"} onClick={() => run("new", () => s.create(title || "New study"))}>Create</Button>
              <Tooltip label="Start from the board on the Analysis page"><Button variant="default" loading={busy === "from"} onClick={() => run("from", () => s.create(title || "From my analysis", activeTree().toPgn()))}>From my analysis</Button></Tooltip>
            </Group>
          </div>
          <div className="card">
            <Text fw={700} mb={6}>Open a study</Text>
            <TextInput placeholder="Paste a study link" value={link} onChange={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && link && run("open", () => s.openLink(link))} />
            <Button mt="sm" variant="default" disabled={!link} loading={busy === "open"} onClick={() => run("open", () => s.openLink(link))}>Open</Button>
          </div>
        </div>
        <Panel title="Your studies" pad={false}>
          {s.known.length ? s.known.map((k) => (
            <div key={k.id} className="listrow" onClick={() => run(k.id, () => s.open(k.id, k.edit))}>
              <Text size="sm" style={{ flex: 1 }} truncate fw={600}>{k.title}</Text>
              <Badge size="xs" variant="light" color={k.edit ? "teal" : "gray"}>{k.edit ? "can edit" : "view only"}</Badge>
              {busy === k.id && <Loader size="xs" />}
            </div>
          )) : <Text size="sm" c="dimmed" p={12}>Studies you make or open appear here.</Text>}
        </Panel>
      </div>
    </div>
  );
}

function StudyView() {
  const s = useStudies();
  const app = useApp();
  const tree = s.tree!;
  const study = s.study!;
  useTree(tree);
  const canEdit = !!s.edit;
  const node = tree.current;
  const [comment, setComment] = useState(node.comment);
  useEffect(() => setComment(node.comment), [node, node.comment]);
  const [renaming, setRenaming] = useState<string>();
  const [name, setName] = useState("");
  const status = { idle: "", loading: "Loading…", saved: "Saved", saving: "Saving…", error: `Not saved: ${s.error}`, readonly: "View only" }[s.status];

  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          <Board fen={tree.fen} rules={tree.rules} chess960={tree.chess960} lastMove={node.lastMove} movable={canEdit ? "both" : undefined}
            onMove={(m) => tree.play(m)} shapes={node.shapes} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title={<Group gap={6} wrap="nowrap"><IconBook size={13} /><Text size="xs" fw={700} truncate maw={190}>{study.title}</Text></Group>}
          right={<Group gap={2} wrap="nowrap">
            <Text size="xs" c={s.status === "error" ? "red" : "dimmed"}>{status}</Text>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><ActionIcon size="sm" variant="subtle" color="gray" aria-label="Study menu"><IconDots size={14} /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconLink size={14} />} onClick={() => copyText(viewLink(study.id))}>Copy view link</Menu.Item>
                {canEdit && <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => copyText(editLink(study.id, s.edit!))}>Copy edit link</Menu.Item>}
                {canEdit && <Menu.Item onClick={() => { setRenaming("study"); setName(study.title); }}>Rename the study</Menu.Item>}
                <Menu.Item onClick={() => app.openGame(tree.clone())}>Open in Analysis</Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<IconX size={14} />} onClick={() => s.close()}>Close</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>}>
          <Text size="xs" c="dimmed">By {study.ownerName}. {canEdit ? "Everyone with the edit link sees your changes as you make them." : "You're following along; changes appear as they're made."}</Text>
          {renaming && (
            <Group gap={6} mt={6} wrap="nowrap">
              <TextInput style={{ flex: 1 }} size="xs" value={name} maxLength={80} onChange={(e) => setName(e.currentTarget.value)} autoFocus />
              <Button size="xs" onClick={() => { (renaming === "study" ? s.renameStudy(name) : s.renameChapter(renaming, name)); setRenaming(undefined); }}>Save</Button>
              <Button size="xs" variant="subtle" onClick={() => setRenaming(undefined)}>Cancel</Button>
            </Group>
          )}
        </Panel>
        <Panel title="Chapters" pad={false} right={canEdit && <Tooltip label="Add a chapter"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => s.addChapter(`Chapter ${study.chapters.length + 1}`)}><IconPlus size={14} /></ActionIcon></Tooltip>}>
          <div style={{ maxHeight: 150, overflowY: "auto" }}>
            {study.chapters.map((c, i) => (
              <div key={c.id} className={"listrow" + (c.id === s.chapter ? " on" : "")} onClick={() => s.selectChapter(c.id)}>
                <Text size="xs" c="dimmed" w={18}>{i + 1}</Text>
                <Text size="sm" style={{ flex: 1 }} truncate>{c.title}</Text>
                {canEdit && (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}><IconDots size={12} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => { setRenaming(c.id); setName(c.title); }}>Rename</Menu.Item>
                      <Menu.Item color="red" disabled={study.chapters.length <= 1} onClick={() => s.deleteChapter(c.id)}>Delete</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </div>
            ))}
          </div>
        </Panel>
        <Panel grow pad={false} title="Moves"><MoveList tree={tree} editable={canEdit} /></Panel>
        <Panel title={node.parent ? `Comment on ${node.san}` : "Comment on the start"}>
          <Textarea size="xs" autosize minRows={2} maxRows={6} disabled={!canEdit} placeholder={canEdit ? "Ideas, plans, what to remember here" : "No comment"}
            value={comment} onChange={(e) => setComment(e.currentTarget.value)} onBlur={() => comment !== node.comment && s.setComment(node, comment)} />
        </Panel>
        <div style={{ padding: 12 }}><NavBar tree={tree} /></div>
      </div>
    </div>
  );
}
