import { Alert, Badge, Button, FileButton, Group, Loader, Menu, NumberInput, ScrollArea, SegmentedControl, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCamera, IconCheck, IconCopy, IconDownload, IconExternalLink, IconPrinter, IconQuestionMark, IconScan, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Board } from "../components/Board";
import { Panel } from "../components/common";
import { GameTree, START_FEN } from "../lib/chess";
import { db } from "../lib/db";
import { decodeGame, Ply } from "../lib/sheet/decode";
import { FIELDS, firstMoveOf, handBox, RESULTS, SHEET, sheetSvg } from "../lib/sheet/layout";
import { grayFromRgba, HalfMarks, PageScan, scanPage, ScanError } from "../lib/sheet/scan";
import { call, copyText, isTauri, load, save } from "../lib/storage";
import { useApp } from "../lib/store";

/**
 * Sheet2PGN: print Castle's scoresheet, fill it in during a game, then scan or
 * photograph it and get the game as PGN. See lib/sheet for how it works.
 */

const say = (message: string) => notifications.show({ message, autoClose: 2200 });

/** Names typed before printing, by sheet number, so a scan can fill them back in. */
type SheetInfo = { headers: Record<string, string>; printed: number };
const sheets = () => load<Record<string, SheetInfo>>("sheets", {});

function printSheets(headers: Record<string, string>, pages: number) {
  const n = (load<number>("sheetCounter", Math.floor(Math.random() * 1000)) + 1) % 1024;
  save("sheetCounter", n);
  save("sheets", { ...sheets(), [n]: { headers, printed: Date.now() } });
  let el = document.getElementById("print-area");
  if (!el) {
    el = document.createElement("div");
    el.id = "print-area";
    el.className = "print-only";
    document.body.appendChild(el);
  }
  el.innerHTML = Array.from({ length: pages }, (_, i) => `<div class="sheet-page">${sheetSvg({ sheet: n, page: i + 1, headers })}</div>`).join("");
  el.classList.add("sheet-print");
  const done = () => el!.classList.remove("sheet-print");
  window.addEventListener("afterprint", done, { once: true });
  setTimeout(() => (isTauri ? call("print_page") : Promise.reject()).catch(() => window.print()), 200);
}

/** A scanned page: what was read, and the picture it came from (for the handwriting). */
interface Page {
  scan: PageScan;
  canvas: HTMLCanvasElement;
  name: string;
}

async function readImage(file: File): Promise<Page> {
  const bitmap = await createImageBitmap(file);
  const f = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * f);
  canvas.height = Math.round(bitmap.height * f);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Let the "Reading…" state show before the work starts.
  await new Promise((r) => setTimeout(r, 30));
  return { scan: scanPage(grayFromRgba(data, canvas.width, canvas.height, Infinity)), canvas, name: file.name };
}

/** A piece of the picture: a box on the sheet, cut out and straightened roughly. */
function Crop({ page, box, row, height = 26 }: { page: Page; box: { x: number; y: number; w: number; h: number }; row?: number; height?: number }) {
  const url = useMemo(() => {
    const map = (x: number, y: number) => (row === undefined ? page.scan.toImage(x, y) : page.scan.inRow(row, x, y));
    const pts = [map(box.x, box.y), map(box.x + box.w, box.y), map(box.x + box.w, box.y + box.h), map(box.x, box.y + box.h)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
    const w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
    const c = document.createElement("canvas");
    c.height = height * 2;
    c.width = Math.round((w / h) * c.height);
    c.getContext("2d")!.drawImage(page.canvas, x0, y0, w, h, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  }, [page, box.x, box.y, box.w, box.h, row, height]);
  return <img src={url} alt="" style={{ height, borderRadius: 3, display: "block", background: "#fff" }} />;
}

const STATUS: Record<Ply["status"], { color: string; label: string }> = {
  ok: { color: "", label: "Read clearly" },
  inferred: { color: "blue", label: "More than one move fits these circles; the moves after it say it was this one" },
  chosen: { color: "teal", label: "Chosen by you" },
  ambiguous: { color: "orange", label: "More than one move fits: check it against the handwriting" },
  guessed: { color: "orange", label: "No legal move fits exactly: this one fits all but one group of circles" },
  unreadable: { color: "red", label: "Nothing fits: pick the move that was played" },
};

export default function ScanPage({ web = false }: { web?: boolean }) {
  const app = useApp();
  const [mode, setMode] = useState<"print" | "scan">(load("scanMode", "scan"));
  const [form, setForm] = useState<Record<string, string>>({});
  const [pages, setPages] = useState(1);
  const [scanned, setScanned] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<Map<number, string>>(new Map());
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string>("*");
  const [selected, setSelected] = useState<number>();

  const ordered = useMemo(() => [...scanned].sort((a, b) => a.scan.page - b.scan.page), [scanned]);
  // Every half-move in order across the pages, with where it is on which page.
  const halves = useMemo(() => {
    const out: { marks: HalfMarks; page: Page; row: number; color: "white" | "black" }[] = [];
    for (const p of ordered) {
      const start = (firstMoveOf(p.scan.page) - 1) * 2;
      p.scan.rows.forEach((r, row) => {
        out[start + row * 2] = { marks: r.white, page: p, row, color: "white" };
        out[start + row * 2 + 1] = { marks: r.black, page: p, row, color: "black" };
      });
    }
    // A missing page leaves a gap: treat it as blank, which ends the game there.
    const blank: HalfMarks = { piece: { filled: [], faint: [], scores: [] }, file: { filled: [], faint: [], scores: [] }, rank: { filled: [], faint: [], scores: [] }, blank: true };
    for (let i = 0; i < out.length; i++) out[i] ??= { marks: blank, page: ordered[0], row: 0, color: i % 2 ? "black" : "white" };
    return out;
  }, [ordered]);
  const game = useMemo(() => decodeGame(halves.map((h) => h.marks), chosen), [halves, chosen]);
  const problems = game.plies.filter((p) => p.status === "ambiguous" || p.status === "guessed" || p.status === "unreadable").length;

  const tree = useMemo(() => {
    const t = new GameTree(START_FEN);
    for (const p of game.plies) if (p.uci) t.play(p.uci);
    for (const f of FIELDS) if (headers[f.tag]) t.headers.set(f.tag, headers[f.tag]);
    t.result = result as any;
    t.toStart();
    return t;
  }, [game, headers, result]);
  const shown = selected !== undefined ? game.plies[selected] : undefined;
  const fen = shown ? shown.fenBefore : game.fen;

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const read: Page[] = [];
      for (const f of files) {
        try { read.push(await readImage(f)); } catch (e: any) { throw new Error(`${f.name}: ${e instanceof ScanError ? e.message : "couldn't read this picture."}`); }
      }
      const all = [...scanned.filter((p) => !read.some((r) => r.scan.page === p.scan.page)), ...read];
      setScanned(all);
      setChosen(new Map());
      setSelected(undefined);
      const first = all.find((p) => p.scan.page === 1) ?? all[0];
      const saved = first.scan.idValid ? sheets()[first.scan.sheet] : undefined;
      if (saved) setHeaders({ ...saved.headers, ...headers });
      const res = all.map((p) => p.scan.result).find(Boolean);
      if (res) setResult(res);
      if (read.some((p) => !p.scan.idValid)) say("A page's number couldn't be read; it's taken as page 1.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (index: number, uci: string) => {
    const next = new Map([...chosen].filter(([i]) => i < index));
    next.set(index, uci);
    setChosen(next);
    setSelected(index);
  };

  const pgn = tree.toPgn();
  const saveName = `${headers.White || "White"} vs ${headers.Black || "Black"}.pgn`;

  return (
    <>
      <div className="toolbar">
        <SegmentedControl value={mode} onChange={(v) => { setMode(v as any); save("scanMode", v); }}
          data={[{ value: "print", label: "1. Print a sheet" }, { value: "scan", label: "2. Scan it" }]} />
        <span style={{ flex: 1 }} />
        <Text size="xs" c="dimmed" className="web-hide-narrow">Sheet2PGN: write your game on paper, get it back as PGN.</Text>
      </div>
      {mode === "print" ? (
        <div className="page scroll">
          <div style={{ maxWidth: 760, width: "100%" }} className="stagger">
            <Panel title="Print scoresheets">
              <Text size="sm" mb={10}>
                Each move has a box to write it in, and three groups of circles: the piece that moved (none for a pawn), and the file and rank of the square it went to.
                Fill those in as you play, then scan or photograph the sheet here. Castle replays the game from the circles, and checks every move is legal.
              </Text>
              <Group grow>
                {FIELDS.slice(0, 2).map((f) => <TextInput key={f.tag} label={f.label} value={form[f.tag] ?? ""} onChange={(e) => setForm({ ...form, [f.tag]: e.currentTarget.value })} placeholder="Leave blank to write by hand" />)}
              </Group>
              <Group grow mt={6}>
                {FIELDS.slice(2).map((f) => <TextInput key={f.tag} label={f.label} value={form[f.tag] ?? ""} onChange={(e) => setForm({ ...form, [f.tag]: e.currentTarget.value })} />)}
              </Group>
              <Group mt={10} align="flex-end">
                <NumberInput label="Pages" description={`${SHEET.rows} moves each`} min={1} max={4} value={pages} onChange={(v) => typeof v === "number" && setPages(v)} w={140} />
                <Button leftSection={<IconPrinter size={16} />} onClick={() => printSheets(Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim())), pages)}>Print</Button>
              </Group>
              <Text size="xs" c="dimmed" mt={8}>Fits A4 and US Letter. Print at actual size if you can, though the scanner copes with scaling. The names typed here are filled back in when you scan on this device.</Text>
            </Panel>
            <Panel title="Preview">
              <div className="sheet-preview" dangerouslySetInnerHTML={{ __html: sheetSvg({ sheet: 0, page: 1, headers: form }) }} />
            </Panel>
          </div>
        </div>
      ) : (
        <div className="page">
          <div className="boardcol">
            <div className="boardrow">
              <Board fen={fen} readOnly lastMove={undefined} arrows={shown?.uci ? [{ from: shown.uci.slice(0, 2), to: shown.uci.slice(2, 4), color: shown.status === "ok" || shown.status === "chosen" ? "green" : "yellow" }] : undefined} />
            </div>
            {shown && <Text size="sm" ta="center" mt={6}>Before {shown.moveNumber}{shown.color === "white" ? "." : "…"} {shown.san ?? "?"}</Text>}
          </div>
          <div className="sidecol wide">
            <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
              <Group gap={8}>
                <FileButton onChange={onFiles} accept="image/*" multiple>
                  {(props) => <Button {...props} leftSection={busy ? <Loader size={14} color="white" /> : web ? <IconCamera size={16} /> : <IconScan size={16} />} disabled={busy}>{busy ? "Reading…" : scanned.length ? "Add or replace pages" : web ? "Photograph or choose a sheet" : "Choose a scan or photo"}</Button>}
                </FileButton>
                {scanned.length > 0 && <Button variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={() => { setScanned([]); setChosen(new Map()); setHeaders({}); setResult("*"); }}>Start over</Button>}
              </Group>
              {error && <Alert color="red" mt={8} p="xs" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
              {!scanned.length && !error && (
                <Text size="sm" c="dimmed" mt={8}>A flat scan works best; a photo is fine if the whole page and its four corner squares are in it. Several pages at once is fine too: they're put in order.</Text>
              )}
              {scanned.length > 0 && (
                <Text size="sm" mt={8}>
                  {ordered.map((p) => `page ${p.scan.page}`).join(", ")} · {game.plies.length} half-moves ·{" "}
                  {problems ? <Text span c="orange" fw={600}>{problems} to check</Text> : <Text span c="teal" fw={600}><IconCheck size={13} style={{ verticalAlign: -2 }} /> all read</Text>}
                  {game.unfinished && <Text span c="orange"> · moves after a blank row were skipped</Text>}
                </Text>
              )}
            </div>
            {scanned.length > 0 && (
              <>
                <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {FIELDS.map((f) => (
                    <div key={f.tag}>
                      <Crop page={ordered.find((p) => p.scan.page === 1) ?? ordered[0]} box={f} height={20} />
                      <TextInput size="xs" placeholder={f.label} value={headers[f.tag] ?? ""} onChange={(e) => setHeaders({ ...headers, [f.tag]: e.currentTarget.value })} />
                    </div>
                  ))}
                  <div>
                    <Text size="xs" c="dimmed" mb={2}>Result</Text>
                    <SegmentedControl size="xs" fullWidth value={result} onChange={setResult} data={[...RESULTS.map((r) => ({ value: r, label: r === "1/2-1/2" ? "½-½" : r })), { value: "*", label: "?" }]} />
                  </div>
                </div>
                <ScrollArea style={{ flex: 1 }}>
                  <div className="scan-moves">
                    {game.plies.map((p) => {
                      const h = halves[p.index];
                      const st = STATUS[p.status];
                      return (
                        <div key={p.index} className={"scan-move" + (selected === p.index ? " on" : "")} onClick={() => setSelected(p.index)}>
                          <Text size="xs" c="dimmed" w={30} ta="right">{p.color === "white" ? `${p.moveNumber}.` : ""}</Text>
                          <Crop page={h.page} box={handBox(h.row, h.color)} row={h.row} />
                          <Menu shadow="md" position="bottom-start" withinPortal>
                            <Menu.Target>
                              <Tooltip label={`${st.label}. Read as ${p.read || "nothing"}.`} openDelay={300}>
                                <Button size="compact-sm" variant={st.color ? "light" : "subtle"} color={st.color || "gray"} rightSection={st.color && p.status !== "chosen" ? <IconQuestionMark size={12} /> : undefined}>
                                  {p.san ?? "?"}
                                </Button>
                              </Tooltip>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>{st.label}</Menu.Label>
                              <ScrollArea.Autosize mah={260}>
                                {p.options.map((o) => <Menu.Item key={o.uci} onClick={() => choose(p.index, o.uci)} rightSection={o.uci === p.uci ? "✓" : undefined}>{o.san}</Menu.Item>)}
                              </ScrollArea.Autosize>
                            </Menu.Dropdown>
                          </Menu>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
                <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
                  <Group gap={6}>
                    {!web && <Button leftSection={<IconExternalLink size={14} />} disabled={!game.plies.length} onClick={() => { const t = tree.clone(); t.toEnd(); app.openGame(t); app.go("analysis"); }}>Open in Analysis</Button>}
                    {!web && <Button variant="default" disabled={!game.plies.length} onClick={() => db.importText(pgn, "", true).then(() => say("Added to the Library"))}>Add to Library</Button>}
                    <Button variant="default" leftSection={<IconCopy size={14} />} disabled={!game.plies.length} onClick={() => { copyText(pgn); say("PGN copied"); }}>Copy PGN</Button>
                    {web && (
                      <Button variant="default" leftSection={<IconDownload size={14} />} disabled={!game.plies.length} onClick={() => {
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([pgn], { type: "application/x-chess-pgn" }));
                        a.download = saveName;
                        a.click();
                      }}>Download</Button>
                    )}
                  </Group>
                  {problems > 0 && <Badge mt={8} color="orange" variant="light">Click the highlighted moves to check them against the handwriting</Badge>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
