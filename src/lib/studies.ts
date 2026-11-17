import { create } from "zustand";
import { GameTree, GNode, moveFromUci } from "./chess";
import { api, onlineToken, onStudyChange, ONLINE_API, useOnline } from "./online";
import { load, save } from "./storage";

/**
 * Studies: shared analysis boards in chapters, kept on Castle Online. Anyone
 * with the link can look; the edit link lets people change it together.
 *
 * Edits save themselves a moment after you stop. Each chapter has a revision:
 * if someone else saved first, the server sends back their version, and the
 * two are merged (every move and line from both, comments kept) and saved again.
 * Changes others make arrive live through the online connection.
 */
export interface Chapter { id: string; title: string; pgn: string; rev: number; updatedAt: number }
export interface Study { id: string; title: string; owner: string; ownerName: string; chapters: Chapter[] }
interface Known { id: string; title: string; edit?: string; openedAt: number }

interface State {
  study?: Study;
  edit?: string;
  chapter?: string;
  tree?: GameTree;
  rev: number;
  status: "idle" | "loading" | "saved" | "saving" | "error" | "readonly";
  error?: string;
  known: Known[];
  open: (id: string, edit?: string) => Promise<void>;
  /** Opens from a pasted link or a bare id. */
  openLink: (text: string) => Promise<void>;
  create: (title: string, pgn?: string) => Promise<void>;
  close: () => void;
  selectChapter: (id: string) => void;
  addChapter: (title: string, pgn?: string) => Promise<void>;
  renameChapter: (id: string, title: string) => Promise<void>;
  deleteChapter: (id: string) => Promise<void>;
  renameStudy: (title: string) => Promise<void>;
  refreshMine: () => Promise<void>;
  setComment: (node: GNode, text: string) => void;
}

const SITE = ONLINE_API.replace(/\/api$/, "");
export const viewLink = (id: string) => `${SITE}/play/#study=${id}`;
export const editLink = (id: string, edit: string) => `${SITE}/play/#study=${id}&edit=${edit}`;

const treeOf = (pgn: string) => (pgn.trim() ? GameTree.fromPgn(pgn) : undefined) ?? new GameTree();

/** Adds every move and line of `from` to `into`, keeping comments from both. */
function merge(from: GNode, into: GNode, target: GameTree) {
  if (from.comment && !into.comment.includes(from.comment)) into.comment = into.comment ? `${into.comment} ${from.comment}` : from.comment;
  for (const child of from.children) {
    const move = child.uci ? moveFromUci(target.posAt(into), child.uci) : undefined;
    const next = move ? target.append(into, move) : undefined;
    if (next) merge(child, next, target);
  }
}

/** Where the current move is, as SAN from the start, so a reloaded tree can stay there. */
const pathOf = (tree: GameTree) => tree.path(tree.current).slice(1).map((n) => n.san);
function goPath(tree: GameTree, sans: string[]) {
  let node = tree.root;
  for (const san of sans) {
    const next = node.children.find((c) => c.san === san);
    if (!next) break;
    node = next;
  }
  tree.go(node);
}

let unsubscribeTree: (() => void) | undefined;
let unsubscribeLive: (() => void) | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let applying = false;

export const useStudies = create<State>((set, get) => {
  const remember = (id: string, title: string, edit?: string) => {
    const known = [{ id, title, edit: edit ?? get().known.find((k) => k.id === id)?.edit, openedAt: Date.now() }, ...get().known.filter((k) => k.id !== id)].slice(0, 50);
    save("studiesKnown", known);
    set({ known });
  };

  const watchTree = (tree: GameTree) => {
    unsubscribeTree?.();
    unsubscribeTree = tree.subscribe(() => {
      if (applying || !get().edit) return;
      dirty = true;
      set({ status: "saving" });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 1000);
    });
  };

  const show = (tree: GameTree, keep?: string[]) => {
    applying = true;
    if (keep) goPath(tree, keep); else tree.toStart();
    applying = false;
    watchTree(tree);
    set({ tree });
  };

  async function saveNow(): Promise<void> {
    const { study, edit, chapter, tree, rev } = get();
    if (!study || !edit || !chapter || !tree) return;
    dirty = false;
    try {
      const r = await fetch(`${ONLINE_API}/study/chapter`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: study.id, edit, chapter, rev, pgn: tree.toPgn() }),
      });
      const d = await r.json();
      if (r.status === 409 && d.conflict) {
        // Someone saved first: take theirs, add ours, and save that.
        const theirs = treeOf(d.chapter.pgn);
        merge(tree.root, theirs.root, theirs);
        const keep = pathOf(tree);
        set({ rev: d.chapter.rev });
        show(theirs, keep);
        return saveNow();
      }
      if (!r.ok) throw new Error(d.error ?? `The server answered ${r.status}.`);
      set({ rev: d.chapter.rev, status: dirty ? "saving" : "saved", study: { ...study, chapters: study.chapters.map((c) => (c.id === chapter ? d.chapter : c)) } });
    } catch (e: any) {
      set({ status: "error", error: e.message });
    }
  }

  /** Someone else changed the study: reload it, unless there are edits here not yet saved. */
  const reload = async () => {
    const { study, chapter, tree } = get();
    if (!study) return;
    const next = await api<Study>(`study?id=${encodeURIComponent(study.id)}`).catch(() => undefined);
    if (!next || get().study?.id !== study.id) return;
    const mine = next.chapters.find((c) => c.id === chapter) ?? next.chapters[0];
    const changed = mine && (mine.id !== chapter || mine.rev !== get().rev);
    set({ study: next });
    if (changed && !dirty && tree) {
      set({ chapter: mine.id, rev: mine.rev });
      show(treeOf(mine.pgn), mine.id === chapter ? pathOf(tree) : undefined);
    }
  };

  return {
    rev: 0,
    status: "idle",
    known: load<Known[]>("studiesKnown", []),
    open: async (id, edit) => {
      set({ status: "loading", error: undefined });
      try {
        const study = await api<Study>(`study?id=${encodeURIComponent(id)}`);
        const first = study.chapters[0];
        const useEdit = edit ?? get().known.find((k) => k.id === id)?.edit;
        set({ study, edit: useEdit, chapter: first.id, rev: first.rev, status: useEdit ? "saved" : "readonly" });
        show(treeOf(first.pgn));
        remember(study.id, study.title, useEdit);
        unsubscribeLive?.();
        unsubscribeLive = onStudyChange((changed) => { if (changed === study.id) reload(); });
        const o = useOnline.getState();
        if (!o.ready) await o.start().catch(() => {});
        useOnline.getState().setExtraRooms([`study:${study.id}`]);
      } catch (e: any) {
        set({ status: "error", error: e.message });
      }
    },
    openLink: async (text) => {
      const t = text.trim();
      const id = /study=([\w-]+)/.exec(t)?.[1] ?? (/^[\w-]{6,}$/.test(t) ? t : undefined);
      const edit = /edit=([\w-]+)/.exec(t)?.[1];
      if (!id) return set({ status: "error", error: "That isn't a study link." });
      await get().open(id, edit);
    },
    create: async (title, pgn) => {
      const o = useOnline.getState();
      if (!o.ready) await o.start();
      const r = await api<{ id: string; edit: string }>("study/create", { token: onlineToken(), name: useOnline.getState().name, title, pgn });
      await get().open(r.id, r.edit);
    },
    close: () => {
      clearTimeout(saveTimer);
      if (dirty) saveNow();
      unsubscribeTree?.();
      unsubscribeLive?.();
      useOnline.getState().setExtraRooms([]);
      set({ study: undefined, edit: undefined, chapter: undefined, tree: undefined, status: "idle" });
    },
    selectChapter: (id) => {
      const c = get().study?.chapters.find((x) => x.id === id);
      if (!c) return;
      if (dirty) { clearTimeout(saveTimer); saveNow(); }
      set({ chapter: c.id, rev: c.rev });
      show(treeOf(c.pgn));
    },
    addChapter: async (title, pgn = "") => {
      const { study, edit } = get();
      if (!study || !edit) return;
      const r = await api<{ chapter: Chapter }>("study/chapter", { id: study.id, edit, title, pgn });
      set({ study: { ...study, chapters: [...study.chapters, r.chapter] } });
      get().selectChapter(r.chapter.id);
    },
    renameChapter: async (id, title) => {
      const { study, edit } = get();
      if (!study || !edit) return;
      await api("study/rename", { id: study.id, edit, chapter: id, title });
      await reload();
    },
    deleteChapter: async (id) => {
      const { study, edit } = get();
      if (!study || !edit) return;
      await api("study/delete-chapter", { id: study.id, edit, chapter: id });
      const left = study.chapters.filter((c) => c.id !== id);
      set({ study: { ...study, chapters: left } });
      if (get().chapter === id && left[0]) get().selectChapter(left[0].id);
    },
    renameStudy: async (title) => {
      const { study, edit } = get();
      if (!study || !edit) return;
      await api("study/rename", { id: study.id, edit, title });
      set({ study: { ...study, title } });
      remember(study.id, title, edit);
    },
    refreshMine: async () => {
      const token = onlineToken();
      if (!token) return;
      const r = await api<{ studies: { id: string; edit: string; title: string; updatedAt: number }[] }>("study/mine", { token }).catch(() => undefined);
      if (!r) return;
      const known = [...get().known];
      for (const s of r.studies) if (!known.some((k) => k.id === s.id)) known.push({ id: s.id, title: s.title, edit: s.edit, openedAt: s.updatedAt });
      save("studiesKnown", known);
      set({ known });
    },
    setComment: (node, text) => {
      node.comment = text;
      get().tree?.touch();
    },
  };
});
