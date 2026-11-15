import { ActionIcon, Badge, Button, Group, Modal, NumberInput, Progress, Select, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { IconAdjustments, IconCpu, IconDatabase, IconDownload, IconFolder, IconPackage, IconPlus, IconRefresh, IconStar, IconStarFilled, IconTool, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { EngineEntry, engineOptions, launch, PLATFORM, setEngineOptions, useEngines } from "../lib/engines";
import { cacheSize, clearEvalCache } from "../lib/review";
import { call, isTauri, load, save } from "../lib/storage";
import { useApp } from "../lib/store";
import { UciOption } from "../lib/uci";

const HIDDEN = new Set(["multipv", "uci_chess960", "ponder", "uci_analysemode", "uci_showwdl", "uci_limitstrength", "uci_elo", "uci_variant"]);

export default function EnginesPage() {
  const { engines, defaultId, refresh, setDefault, locate, addCustom, removeCustom } = useEngines();
  const go = useApp((s) => s.go);
  const [info, setInfo] = useState<Record<string, { name: string; options: UciOption[] }>>({});
  const [configuring, setConfiguring] = useState<EngineEntry>();
  const [installing, setInstalling] = useState<Record<string, string>>({});

  // Ask each installed engine for its real name and options.
  useEffect(() => {
    let live = true;
    (async () => {
      for (const e of engines) {
        if (!e.path || info[e.id]) continue;
        try {
          const engine = await launch(e, { Threads: "1", Hash: "16" });
          if (live) setInfo((i) => ({ ...i, [e.id]: { name: engine.name + (engine.author ? ` · ${engine.author}` : ""), options: engine.options } }));
          engine.quit();
        } catch {
          /* leave it as "Ready" */
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines]);

  useEffect(() => {
    if (!isTauri) return;
    const a = listen<[string, string]>("brew-progress", (e) => setInstalling((m) => ({ ...m, [e.payload[0]]: e.payload[1] })));
    const b = listen<[string, boolean]>("brew-done", (e) => {
      setInstalling((m) => { const n = { ...m }; delete n[e.payload[0]]; return n; });
      refresh();
    });
    return () => { a.then((f) => f()); b.then((f) => f()); };
  }, [refresh]);

  const choose = async () => {
    const path = await openDialog({ defaultPath: "/opt/homebrew/bin" });
    return typeof path === "string" ? path : undefined;
  };

  return (
    <div className="page scroll">
      <Group mb="md">
        <Text fw={700} size="lg">Engines</Text>
        <Text c="dimmed">{engines.filter((e) => e.path).length} of {engines.length} ready</Text>
        <span style={{ flex: 1 }} />
        <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={() => refresh()}>Rescan</Button>
        <Button leftSection={<IconPlus size={14} />} onClick={async () => { const p = await choose(); if (p) addCustom(p); }}>Add engine</Button>
      </Group>
      <div className="grid stagger">
        {engines.map((e) => {
          const isDefault = defaultId === e.id;
          const Icon = e.bundled ? IconPackage : e.custom ? IconTool : IconCpu;
          const progress = e.formula ? installing[e.formula] : undefined;
          return (
            <div key={e.id} className="card" style={{ opacity: e.path ? 1 : 0.75, borderColor: isDefault ? "var(--mantine-primary-color-filled)" : undefined }}>
              <Group gap={10} wrap="nowrap" mb={6}>
                <Icon size={26} color={e.path ? "var(--mantine-primary-color-filled)" : "#666"} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={700}>{e.name}</Text>
                  <Text size="xs" c="dimmed" truncate>{info[e.id]?.name ?? (e.path ? "Ready" : "Not installed")}</Text>
                </div>
                <Badge variant="light" color={e.bundled ? undefined : e.path ? "green" : "gray"}>{e.bundled ? "Built in" : e.path ? "Installed" : "Missing"}</Badge>
              </Group>
              <Text size="sm" c="dimmed" mih={36}>{e.summary}</Text>
              {progress !== undefined ? (
                <><Text size="xs" c="dimmed" truncate mt={4}>{progress || "Starting…"}</Text><Progress value={100} animated size="xs" /></>
              ) : !e.path && e.hint ? <Text size="xs" ff="monospace" c="dimmed" mt={4} className="selectable">{e.hint}</Text> : null}
              <Group gap={6} mt={10}>
                {e.path ? (
                  <>
                    <Button variant="default" disabled={isDefault} leftSection={isDefault ? <IconStarFilled size={13} /> : <IconStar size={13} />} onClick={() => setDefault(e.id)}>{isDefault ? "Default" : "Set default"}</Button>
                    <Tooltip label="Engine options"><ActionIcon variant="default" disabled={!info[e.id]} onClick={() => setConfiguring(e)}><IconAdjustments size={15} /></ActionIcon></Tooltip>
                  </>
                ) : e.formula && PLATFORM === "mac" ? (
                  <Button variant="light" leftSection={<IconDownload size={14} />} loading={progress !== undefined} onClick={() => { setInstalling((m) => ({ ...m, [e.formula!]: "" })); call("brew_install", { formula: e.formula }).catch(() => setInstalling((m) => { const n = { ...m }; delete n[e.formula!]; return n; })); }}>Install with Homebrew</Button>
                ) : null}
                <span style={{ flex: 1 }} />
                {e.custom ? (
                  <ActionIcon variant="default" color="red" onClick={() => removeCustom(e.id)}><IconTrash size={15} /></ActionIcon>
                ) : !e.bundled ? (
                  <Tooltip label="Choose where this engine's binary lives"><Button variant="default" leftSection={<IconFolder size={14} />} onClick={async () => { const p = await choose(); if (p) locate(e.id, p); }}>{e.path ? "Change" : "Locate…"}</Button></Tooltip>
                ) : null}
              </Group>
            </div>
          );
        })}
      </div>

      <Text fw={700} size="lg" mt="xl" mb="sm">Endgame tablebases</Text>
      <Syzygy />

      <Text fw={700} size="lg" mt="xl" mb="sm">Analysis cache</Text>
      <CacheCard />
      <Text size="xs" c="dimmed" mt="lg">Threads and hash for all engines are on the <a style={{ color: "inherit", textDecoration: "underline", cursor: "pointer" }} onClick={() => go("settings")}>Settings page</a>.</Text>

      {configuring && <OptionsModal engine={configuring} options={info[configuring.id]?.options ?? []} onClose={() => setConfiguring(undefined)} />}
    </div>
  );
}

function CacheCard() {
  const [n, setN] = useState(cacheSize());
  const [cloud, setCloud] = useState(load("cloudEval", true));
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <Group>
        <IconDatabase size={22} />
        <div style={{ flex: 1 }}>
          <Text fw={600}>{n.toLocaleString()} positions remembered</Text>
          <Text size="xs" c="dimmed">Engine results are kept per position, so revisiting a position or re-reviewing a game is instant.</Text>
        </div>
        <Button variant="default" disabled={!n} onClick={() => { clearEvalCache(); setN(0); }}>Clear</Button>
      </Group>
      <Switch mt="sm" label="Show Lichess's cloud evaluation while the local engine is off" checked={cloud} onChange={(e) => { setCloud(e.currentTarget.checked); save("cloudEval", e.currentTarget.checked); }} />
    </div>
  );
}

/** Downloads the 3-4-5 piece Syzygy tables and points every engine at them. */
function Syzygy() {
  const [dir, setDir] = useState("");
  const [have, setHave] = useState(0);
  const [state, setState] = useState<{ done: number; total: number; error?: string }>();
  const [active, setActive] = useState(!!load("syzygyPath", ""));
  const TOTAL = 290;

  const scan = async () => {
    const d = await call<string>("app_dir", { sub: "syzygy" }).catch(() => "");
    setDir(d);
    if (!d) return [] as string[];
    const files = await call<[string, number][]>("list_dir", { path: d }).catch(() => [] as [string, number][]);
    const names = files.filter(([n, size]) => /\.rtb[wz]$/.test(n) && size > 0).map(([n]) => n);
    setHave(names.length);
    return names;
  };
  useEffect(() => { scan(); }, []);

  const start = async () => {
    setState({ done: 0, total: 0 });
    try {
      const existing = new Set(await scan());
      const d = dir || (await call<string>("app_dir", { sub: "syzygy" }));
      const wanted: [string, string][] = [];
      for (const kind of ["wdl", "dtz"]) {
        const base = `https://tablebase.lichess.ovh/tables/standard/3-4-5-${kind}/`;
        const html = await fetch(base).then((r) => r.text());
        for (const m of html.matchAll(/href="([A-Za-z]+v[A-Za-z]+\.rtb[wz])"/g)) if (!existing.has(m[1])) wanted.push([base + m[1], m[1]]);
      }
      if (!wanted.length) { setState(undefined); return enable(d); }
      let done = 0;
      let index = 0;
      setState({ done: 0, total: wanted.length });
      const next = () => {
        if (index >= wanted.length) return;
        const [url, name] = wanted[index++];
        call("download", { id: `syzygy-${name}`, url, dest: `${d}/${name}` }).catch((e) => setState((s) => s && { ...s, error: String(e) }));
      };
      const un = await listen<{ id: string; done: boolean; error?: string }>("download-progress", (e) => {
        if (!e.payload.id.startsWith("syzygy-") || !e.payload.done) return;
        if (e.payload.error) setState((s) => s && { ...s, error: e.payload.error });
        done++;
        setState((s) => s && { ...s, done });
        if (done >= wanted.length) { un(); setState(undefined); scan(); enable(d); } else next();
      });
      for (let i = 0; i < 4; i++) next();
    } catch (e: any) {
      setState({ done: 0, total: 0, error: String(e.message ?? e) });
    }
  };
  const enable = (d: string) => { save("syzygyPath", d); setActive(true); };

  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <Group>
        <IconDatabase size={22} />
        <div style={{ flex: 1 }}>
          <Text fw={600}>Syzygy 3-4-5 piece tables {have >= TOTAL ? "installed" : have ? `(${have} of ${TOTAL} files)` : "not installed"}</Text>
          <Text size="xs" c="dimmed">Lets engines play endgames with five pieces or fewer perfectly, with no internet. About 1 GB download. Engines that support Syzygy get the folder automatically.</Text>
        </div>
        {have < TOTAL && <Button variant="light" leftSection={<IconDownload size={14} />} loading={!!state && !state.error} onClick={start}>Download</Button>}
      </Group>
      {state && state.total > 0 && <><Progress mt="sm" value={(state.done / state.total) * 100} size="sm" animated /><Text size="xs" c="dimmed" mt={2}>{state.done} of {state.total} files</Text></>}
      {state?.error && <Text size="xs" c="red" mt={4}>{state.error}</Text>}
      {have > 0 && <Switch mt="sm" label="Use these tables in every engine" checked={active} onChange={(e) => { setActive(e.currentTarget.checked); save("syzygyPath", e.currentTarget.checked ? dir : ""); }} />}
    </div>
  );
}

/** Every option an engine reports, saved per engine and applied whenever it starts. */
function OptionsModal({ engine, options, onClose }: { engine: EngineEntry; options: UciOption[]; onClose: () => void }) {
  const [saved, setSaved] = useState(engineOptions(engine.id));
  const [filter, setFilter] = useState("");
  const set = (opt: UciOption, value: string) => {
    const next = { ...saved };
    if (value === opt.default) delete next[opt.name];
    else next[opt.name] = value;
    setSaved(next);
    setEngineOptions(engine.id, next);
  };
  const shown = options.filter((o) => o.kind !== "button" && !HIDDEN.has(o.name.toLowerCase()) && o.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal opened onClose={onClose} size={560} title={<Text fw={700}>{engine.name} options</Text>}>
      <Group mb="sm">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>{Object.keys(saved).length} changed. Applies the next time the engine starts.</Text>
        <TextInput w={150} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
      </Group>
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        {shown.map((o) => {
          const value = saved[o.name] ?? o.default;
          const label = <Text size="sm" fw={saved[o.name] !== undefined ? 700 : 400} style={{ flex: 1 }}>{o.name}</Text>;
          return (
            <Group key={o.name} py={5} style={{ borderBottom: "1px solid #ffffff0a" }} wrap="nowrap">
              {label}
              {o.kind === "check" && <Switch checked={value === "true"} onChange={(e) => set(o, e.currentTarget.checked ? "true" : "false")} />}
              {o.kind === "spin" && <><NumberInput w={110} value={parseInt(value, 10) || 0} min={o.min} max={o.max} onChange={(v) => typeof v === "number" && set(o, String(v))} />{o.min !== undefined && o.max !== undefined && <Text size="xs" c="dimmed" w={96}>{o.min}–{o.max}</Text>}</>}
              {o.kind === "combo" && <Select w={200} value={value} data={o.choices} onChange={(v) => v && set(o, v)} />}
              {o.kind === "string" && <TextInput w={230} value={value === "<empty>" ? "" : value} onChange={(e) => set(o, e.currentTarget.value || o.default)} />}
            </Group>
          );
        })}
      </div>
      <Group justify="space-between" mt="md">
        <Button variant="default" color="red" disabled={!Object.keys(saved).length} onClick={() => { setSaved({}); setEngineOptions(engine.id, {}); }}>Reset all</Button>
        <Button onClick={onClose}>Done</Button>
      </Group>
    </Modal>
  );
}
