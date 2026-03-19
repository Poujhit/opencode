import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createOpencodeClient,
  type Event,
  type FileDiff,
  type Message,
  type OpencodeClient,
  type Part,
  type Session,
  type SessionStatus,
} from "@opencode-ai/sdk/v2/client";

const VIEW = "opencodeV2.chat";
const STORE = "opencodeV2.session";
const BASE = "opencode-v2-base";
const NEXT = "opencode-v2-proposed";

type UserMsg = Extract<Message, { role: "user" }>
type AssistantMsg = Extract<Message, { role: "assistant" }>

type InPart =
  | {
      id?: string
      type: "text"
      text: string
    }
  | {
      id?: string
      type: "file"
      mime: string
      filename?: string
      url: string
      source?: {
        type: "file"
        path: string
        text: {
          value: string
          start: number
          end: number
        }
      }
    }

type Msg = {
  info: Message
  parts: Part[]
  opt?: boolean
}

type Kind = "added" | "deleted" | "modified"

type Diff = FileDiff & {
  uri: vscode.Uri
  base: vscode.Uri
  next: vscode.Uri
  kind: Kind
}

type Wait = {
  id?: NodeJS.Timeout
  msg?: boolean
  diff?: boolean
  sess?: boolean
  stat?: boolean
}

type BoxState = {
  dir: vscode.WorkspaceFolder
  sid?: string
  sess?: Session
  msg: Msg[]
  diff: Diff[]
  stat: string
  err?: string
  wait: Wait
  cold?: boolean
}

type FileArg = {
  folder?: string
  file?: string
}

type ViewPart = {
  id: string
  kind: "text" | "reasoning" | "tool" | "file" | "meta"
  title?: string
  text?: string
  status?: string
  tool?: string
}

type ViewDiff = {
  file: string
  kind: Kind
  add: number
  del: number
}

type ViewMsg = {
  id: string
  role: "user" | "assistant"
  parts: ViewPart[]
  pending: boolean
  error?: string
  opt?: boolean
}

type ViewTurn = {
  id: string
  user: ViewMsg
  assistant: ViewMsg[]
  active: boolean
  thinking: boolean
  diff: ViewDiff[]
}

class Docs implements vscode.TextDocumentContentProvider {
  private data = new Map<string, string>();
  private out = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.out.event;

  set(uri: vscode.Uri, text: string) {
    this.data.set(uri.toString(), text);
    this.out.fire(uri);
  }

  del(uri: vscode.Uri) {
    if (!this.data.delete(uri.toString())) {return;}
    this.out.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri) {
    return this.data.get(uri.toString()) ?? "";
  }
}

class Ext implements vscode.WebviewViewProvider, vscode.Disposable {
  private ctx: vscode.ExtensionContext;
  private docs = new Docs();
  private out = vscode.window.createOutputChannel("opencode v2");
  private bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private scm = vscode.scm.createSourceControl("opencodeV2.review", "opencode v2");
  private grp = this.scm.createResourceGroup("changes", "Changes");
  private map = new Map<string, BoxState>();
  private bySid = new Map<string, string>();
  private ids: Record<string, string>;
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private proc?: ChildProcessWithoutNullStreams;
  private url?: string;
  private client?: OpencodeClient;
  private boot?: Promise<OpencodeClient>;
  private evt?: AbortController;
  private loop?: Promise<void>;
  private conn = "idle";
  private note = "Idle";
  private live = false;
  private auto = new Map<string, string>();

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    this.ids = ctx.workspaceState.get<Record<string, string>>(STORE, {});
    this.bar.command = "opencodeV2.openChat";
    this.bar.show();
    this.scm.quickDiffProvider = {
      provideOriginalResource: (uri, _token) => {
        const box = this.pick(uri);
        if (!box) {return;}
        return box.diff.find((item) => same(item.uri, uri))?.next;
      },
    };
  }

  get provider() {
    return this.docs;
  }

  get shown() {
    return Boolean(this.view || this.panel);
  }

  dispose() {
    this.evt?.abort();
    this.proc?.kill();
    this.panel?.dispose();
    this.view = undefined;
    this.panel = undefined;
    this.bar.dispose();
    this.grp.dispose();
    this.scm.dispose();
    this.out.dispose();
  }

  async resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.bind(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) {this.view = undefined;}
    });
    if (this.cfg().get("autoStartServer", true)) {
      void this.ensure();
    }
    this.draw();
  }

  async open() {
    if (this.place() === "panel") {
      const panel =
        this.panel ??
        vscode.window.createWebviewPanel("opencodeV2.panel", "opencode v2", vscode.ViewColumn.Beside, {
          enableScripts: true,
          retainContextWhenHidden: true,
        });
      if (!this.panel) {
        this.panel = panel;
        this.bind(panel.webview);
        panel.onDidDispose(() => {
          if (this.panel === panel) {this.panel = undefined;}
        });
      }
      panel.reveal(vscode.ViewColumn.Beside, false);
      await this.ensure();
      this.draw();
      return;
    }

    await vscode.commands.executeCommand("workbench.view.extension.opencodeV2");
    await vscode.commands.executeCommand(`${VIEW}.focus`);
    await this.ensure();
  }

  async start(folder?: vscode.WorkspaceFolder) {
    const box = this.box(folder ?? this.scope());
    if (!box) {return;}
    await this.ensure();
    await this.make(box.dir);
    this.draw();
  }

  async send(text: string) {
    const box = this.box(this.scope());
    if (!box) {return;}
    const body = text.trim();
    if (!body) {return;}
    await this.post(box.dir, {
      parts: [{ type: "text", text: body }],
    });
  }

  async sendFile() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a workspace file before sending it to opencode v2.");
      return;
    }

    const box = this.box(vscode.workspace.getWorkspaceFolder(doc.uri));
    if (!box) {
      void vscode.window.showWarningMessage("The active file is not inside an open workspace folder.");
      return;
    }

    const text = doc.getText();
    const ref = this.ref(doc.uri, box.dir);
    await this.post(box.dir, {
      noReply: true,
      parts: [
        { type: "text", text: `Context: ${ref}` },
        {
          type: "file",
          mime: "text/plain",
          filename: path.basename(doc.uri.fsPath),
          url: doc.uri.toString(),
          source: {
            type: "file",
            path: doc.uri.fsPath,
            text: {
              value: text,
              start: 0,
              end: text.length,
            },
          },
        },
      ],
    });
    await this.open();
  }

  async sendSelection() {
    const edit = vscode.window.activeTextEditor;
    if (!edit || edit.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a workspace file with a selection before sending it to opencode v2.");
      return;
    }
    if (edit.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select some text before running opencode v2: Send Selection.");
      return;
    }

    const box = this.box(vscode.workspace.getWorkspaceFolder(edit.document.uri));
    if (!box) {
      void vscode.window.showWarningMessage("The active selection is not inside an open workspace folder.");
      return;
    }

    const doc = edit.document;
    const sel = edit.selection;
    const text = doc.getText(sel);
    const start = doc.offsetAt(sel.start);
    const end = doc.offsetAt(sel.end);
    const ref = this.ref(doc.uri, box.dir, sel);

    await this.post(box.dir, {
      noReply: true,
      parts: [
        { type: "text", text: `Context: ${ref}` },
        {
          type: "file",
          mime: "text/plain",
          filename: path.basename(doc.uri.fsPath),
          url: doc.uri.toString(),
          source: {
            type: "file",
            path: doc.uri.fsPath,
            text: {
              value: text,
              start,
              end,
            },
          },
        },
      ],
    });
    await this.open();
  }

  async reviewFile(arg?: FileArg) {
    const box = this.target(arg?.folder) ?? this.box(this.scope());
    if (!box) {return;}
    await this.sync(box.dir, { diff: true });
    const item = await this.file(box, arg?.file);
    if (!item) {return;}
    await vscode.commands.executeCommand(
      "vscode.diff",
      item.base,
      item.next,
      `${this.label(box, item)} (opencode v2)`,
    );
  }

  async review(arg?: FileArg) {
    const box = this.target(arg?.folder) ?? this.box(this.scope());
    if (!box) {return;}
    await this.sync(box.dir, { diff: true });
    if (box.diff.length === 0) {
      void vscode.window.showInformationMessage("No file changes are available for the current opencode v2 session.");
      return;
    }

    const title = `opencode v2: ${box.dir.name}`;
    const list = box.diff.map((item) => ({
      left: item.base,
      right: item.next,
      original: item.base,
      modified: item.next,
      uri: item.uri,
      label: this.label(box, item),
      title: this.label(box, item),
    }));

    const key = this.stamp(box.diff);
    this.auto.set(this.key(box.dir), key);

    const run = vscode.commands.executeCommand("vscode.changes", title, list);
    await Promise.resolve(run).catch(async () => {
      await this.reviewFile({ folder: this.key(box.dir), file: box.diff[0]?.file });
      void vscode.window.showWarningMessage("VS Code multi-file review is unavailable, so opencode v2 opened the first diff.");
    });
  }

  async apply(arg?: FileArg) {
    const box = this.target(arg?.folder) ?? this.box(this.scope());
    if (!box) {return;}
    const item = await this.file(box, arg?.file);
    if (!item) {return;}
    await this.write(box, item, "apply");
  }

  async reject(arg?: FileArg) {
    const box = this.target(arg?.folder) ?? this.box(this.scope());
    if (!box) {return;}
    const item = await this.file(box, arg?.file);
    if (!item) {return;}
    await this.write(box, item, "reject");
  }

  private bind(webview: vscode.Webview) {
    webview.options = {
      enableScripts: true,
    };
    webview.html = this.html(webview);
    webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        this.draw();
        return;
      }
      if (msg?.type === "prompt" && typeof msg.text === "string") {
        void this.send(msg.text);
        return;
      }
      if (msg?.type === "start") {
        void this.start();
        return;
      }
      if (msg?.type === "review") {
        void this.review();
        return;
      }
      if (msg?.type === "refresh") {
        const box = this.box(this.scope());
        if (!box) {return;}
        void this.sync(box.dir, { sess: true, msg: true, diff: true, stat: true });
        return;
      }
      if (msg?.type === "file" && typeof msg.file === "string" && typeof msg.act === "string") {
        const arg = { folder: msg.folder as string | undefined, file: msg.file };
        if (msg.act === "review") {void this.reviewFile(arg);}
        if (msg.act === "apply") {void this.apply(arg);}
        if (msg.act === "reject") {void this.reject(arg);}
      }
    });
  }

  private cfg() {
    return vscode.workspace.getConfiguration("opencodeV2");
  }

  private place() {
    return this.cfg().get("chatLocation", "sidebar");
  }

  private key(dir: vscode.WorkspaceFolder) {
    return dir.uri.toString();
  }

  private box(dir?: vscode.WorkspaceFolder) {
    if (!dir) {return;}
    const key = this.key(dir);
    const found = this.map.get(key);
    if (found) {return found;}
    const box: BoxState = {
      dir,
      sid: this.ids[key],
      msg: [],
      diff: [],
      stat: "idle",
      wait: {},
    };
    if (box.sid) {this.bySid.set(box.sid, key);}
    this.map.set(key, box);
    return box;
  }

  private target(key?: string) {
    if (!key) {return;}
    const dir = vscode.workspace.workspaceFolders?.find((item) => this.key(item) === key);
    return this.box(dir);
  }

  private scope() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const dir = vscode.workspace.getWorkspaceFolder(uri);
      if (dir) {return dir;}
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private pick(uri: vscode.Uri) {
    const dir = vscode.workspace.getWorkspaceFolder(uri);
    return this.box(dir);
  }

  private ref(uri: vscode.Uri, dir: vscode.WorkspaceFolder, sel?: vscode.Selection) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!sel || sel.isEmpty) {return `@${rel}`;}
    const a = sel.start.line + 1;
    const b = sel.end.line + 1;
    return a === b ? `@${rel}#L${a}` : `@${rel}#L${a}-${b}`;
  }

  private uri(dir: vscode.WorkspaceFolder, file: string) {
    return path.isAbsolute(file) ? vscode.Uri.file(file) : vscode.Uri.joinPath(dir.uri, file);
  }

  private label(box: BoxState, item: Diff) {
    return vscode.workspace.asRelativePath(item.uri, false) || path.relative(box.dir.uri.fsPath, item.uri.fsPath) || item.file;
  }

  private draw() {
    const data = this.snap();
    this.view?.webview.postMessage({ type: "state", data });
    this.panel?.webview.postMessage({ type: "state", data });
    this.bar.text = `$(comment-discussion) opencode v2`;
    this.bar.tooltip = `${data.conn}: ${data.note}`;
    this.grp.resourceStates = [...this.map.values()].flatMap((box) =>
      box.diff.map((item) => ({
        resourceUri: item.uri,
        command: {
          command: "opencodeV2.reviewFile",
          title: "Review File",
          arguments: [{ folder: this.key(box.dir), file: item.file }],
        },
        decorations: {
          strikeThrough: item.kind === "deleted",
          tooltip: `${this.label(box, item)} (${item.kind})`,
          letter: item.kind === "added" ? "A" : item.kind === "deleted" ? "D" : "M",
        },
        contextValue: `opencodeV2.${item.kind}`,
      })),
    );
  }

  refresh() {
    this.draw();
  }

  warm() {
    return this.ensure();
  }

  private snap() {
    const dir = this.scope();
    const box = this.box(dir);
    const data = box
      ? {
          folder: this.key(box.dir),
          name: box.dir.name,
          sid: box.sid,
          title: box.sess?.title,
          stat: box.err ? `${box.stat} - ${box.err}` : box.stat,
          turn: this.turns(box),
          diff: box.diff.map((item) => ({
            file: item.file,
            kind: item.kind,
            add: item.additions,
            del: item.deletions,
          })),
        }
      : undefined;
    return {
      conn: this.conn,
      note: this.note,
      box: data,
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
    };
  }

  private turns(box: BoxState) {
    const active = this.active(box);
    const list: ViewTurn[] = [];
    const by = new Map<string, ViewTurn>();
    for (const item of box.msg) {
      if (item.info.role === "user") {
        const turn: ViewTurn = {
          id: item.info.id,
          user: this.show(item),
          assistant: [],
          active: item.info.id === active,
          thinking: false,
          diff: [],
        };
        list.push(turn);
        by.set(item.info.id, turn);
        continue;
      }
      const turn = by.get(item.info.parentID);
      if (!turn) {continue;}
      turn.assistant.push(this.show(item));
    }
    return list.map((item) => {
      const raw = this.msg(box, item.id)?.info;
      const diff = raw?.role === "user" ? this.files(box, raw, item.active) : [];
      const ready = item.assistant.some((msg) => msg.error || msg.parts.length > 0);
      return {
        ...item,
        diff,
        thinking: item.active && !ready,
      };
    });
  }

  private files(box: BoxState, info: UserMsg, active: boolean) {
    const list: Array<FileDiff | Diff> = info.summary?.diffs?.length ? info.summary.diffs : active ? box.diff : [];
    const seen = new Set<string>();
    return list.flatMap<ViewDiff>((item) => {
      if (seen.has(item.file)) {return [];}
      seen.add(item.file);
      return [{
        file: item.file,
        kind: "kind" in item ? item.kind : this.kind(item),
        add: item.additions,
        del: item.deletions,
      }];
    });
  }

  private kind(item: FileDiff) {
    if (item.before === "" && item.after !== "") {return "added" as const;}
    if (item.after === "" && item.before !== "") {return "deleted" as const;}
    return "modified" as const;
  }

  private active(box: BoxState) {
    for (let i = box.msg.length - 1; i >= 0; i--) {
      const item = box.msg[i];
      if (item.info.role === "assistant" && typeof item.info.time.completed !== "number") {
        return item.info.parentID;
      }
    }
    if (box.stat === "idle") {return;}
    for (let i = box.msg.length - 1; i >= 0; i--) {
      const item = box.msg[i];
      if (item.info.role === "user") {return item.info.id;}
    }
  }

  private show(item: Msg): ViewMsg {
    const err =
      item.info.role === "assistant" && typeof item.info.error?.data?.message === "string"
        ? item.info.error.data.message
        : undefined;
    return {
      id: item.info.id,
      role: item.info.role,
      parts: this.parts(item.parts),
      pending: item.info.role === "assistant" && typeof item.info.time.completed !== "number",
      error: err,
      opt: item.opt,
    };
  }

  private parts(parts: Part[]): ViewPart[] {
    return parts
      .flatMap<ViewPart>((part) => {
        if (part.type === "text") {
          if (!part.text.trim()) {return [];}
          return [{ id: part.id, kind: "text", text: part.text } satisfies ViewPart];
        }
        if (part.type === "reasoning") {
          if (!part.text.trim()) {return [];}
          return [{ id: part.id, kind: "reasoning", title: "Thinking", text: part.text } satisfies ViewPart];
        }
        if (part.type === "subtask") {
          return [{ id: part.id, kind: "meta", title: "Subtask", text: part.description || part.prompt } satisfies ViewPart];
        }
        if (part.type === "file") {
          const source = part.source && "path" in part.source ? part.source.path : undefined;
          return [{
            id: part.id,
            kind: "file",
            title: part.filename ?? source ?? part.url,
            text: part.mime,
          } satisfies ViewPart];
        }
        if (part.type === "tool") {
          const title = "title" in part.state ? part.state.title : undefined;
          const text =
            "output" in part.state && typeof part.state.output === "string"
              ? part.state.output
              : "error" in part.state && typeof part.state.error === "string"
                ? part.state.error
                : typeof part.state.input?.command === "string"
                  ? part.state.input.command
                  : undefined;
          return [{
            id: part.id,
            kind: "tool",
            tool: part.tool,
            title: title ?? part.tool,
            text,
            status: part.state.status,
          } satisfies ViewPart];
        }
        if (part.type === "patch") {
          return [{ id: part.id, kind: "meta", title: "Patch", text: `Patched ${part.files.length} file(s)` } satisfies ViewPart];
        }
        if (part.type === "step-start") {
          return [{ id: part.id, kind: "meta", title: "Step", text: "Working" } satisfies ViewPart];
        }
        if (part.type === "step-finish") {
          return [{ id: part.id, kind: "meta", title: "Step", text: `Completed ${part.reason}` } satisfies ViewPart];
        }
        if (part.type === "retry") {
          return [{
            id: part.id,
            kind: "meta",
            title: `Retry ${part.attempt}`,
            text: part.error.data.message,
          } satisfies ViewPart];
        }
        if (part.type === "agent") {
          return [{ id: part.id, kind: "meta", title: "Agent", text: part.name } satisfies ViewPart];
        }
        if (part.type === "compaction") {
          return [{
            id: part.id,
            kind: "meta",
            title: "Compaction",
            text: part.auto ? "Auto compaction" : "Compaction",
          } satisfies ViewPart];
        }
        if (part.type === "snapshot") {
          return [{ id: part.id, kind: "meta", title: "Snapshot" } satisfies ViewPart];
        }
        return [];
      })
      .filter((item) => (item.text ?? item.title ?? "").trim().length > 0);
  }

  private msg(box: BoxState, id: string) {
    return box.msg.find((item) => item.info.id === id);
  }

  private put(box: BoxState, info: Message) {
    const msg = this.msg(box, info.id);
    if (msg) {
      msg.info = info;
      msg.opt = false;
      return msg;
    }
    const next = { info, parts: [] } satisfies Msg;
    insertMsg(box.msg, next);
    return next;
  }

  private cut(box: BoxState, id: string) {
    box.msg = box.msg.filter((item) => item.info.id !== id);
  }

  private part(box: BoxState, messageID: string, partID: string) {
    const msg = this.msg(box, messageID);
    if (!msg) {return;}
    return msg.parts.find((item) => item.id === partID);
  }

  private add(box: BoxState, part: Part) {
    const msg = this.msg(box, part.messageID);
    if (!msg) {
      this.mark(box, { msg: true, stat: true });
      return false;
    }
    const cur = msg.parts.find((item) => item.id === part.id);
    if (cur) {
      Object.assign(cur, part);
      return true;
    }
    insertPart(msg.parts, part);
    return true;
  }

  private delta(box: BoxState, props: { messageID: string; partID: string; field: string; delta: string }) {
    const part = this.part(box, props.messageID, props.partID);
    if (!part) {
      this.mark(box, { msg: true, stat: true });
      return false;
    }
    const data = part as Record<string, unknown>;
    const prev = data[props.field];
    if (typeof prev !== "string" && prev !== undefined) {return false;}
    data[props.field] = `${prev ?? ""}${props.delta}`;
    return true;
  }

  private dropPart(box: BoxState, props: { messageID: string; partID: string }) {
    const msg = this.msg(box, props.messageID);
    if (!msg) {return false;}
    msg.parts = msg.parts.filter((item) => item.id !== props.partID);
    return true;
  }

  private merge(box: BoxState, list: Msg[]) {
    const opt = box.msg.filter((item) => item.opt);
    if (opt.length === 0) {
      box.msg = list;
      return;
    }
    const next = list.map((item) => ({
      info: item.info,
      parts: [...item.parts],
    } satisfies Msg));
    for (const item of opt) {
      const hit = next.find((msg) => msg.info.id === item.info.id);
      if (!hit) {
        insertMsg(next, cloneMsg(item));
        continue;
      }
      for (const part of item.parts) {
        if (hit.parts.find((entry) => entry.id === part.id)) {continue;}
        insertPart(hit.parts, structuredClone(part));
      }
    }
    box.msg = next;
  }

  private optimistic(box: BoxState, sid: string, parts: InPart[]) {
    const next = parts.map((part) => ({
      ...part,
      id: part.id ?? token("part"),
    }));
    const last = [...box.msg].reverse().find((item): item is Msg & { info: UserMsg } => item.info.role === "user");
    const info: UserMsg = {
      id: token("message"),
      sessionID: sid,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: last?.info.agent ?? "opencode",
      model: last?.info.model ?? {
        providerID: "opencode",
        modelID: "vscode-v2",
      },
      variant: last?.info.variant,
    };
    insertMsg(box.msg, {
      info,
      parts: next.map((part) => this.input(sid, info.id, part)),
      opt: true,
    });
    return {
      id: info.id,
      parts: next,
    };
  }

  private input(sid: string, mid: string, part: InPart & { id: string }): Part {
    if (part.type === "text") {
      return {
        id: part.id,
        type: "text",
        text: part.text,
        sessionID: sid,
        messageID: mid,
      };
    }
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID: sid,
      messageID: mid,
    };
  }

  private html(webview: vscode.Webview) {
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return webviewHtml(nonce, csp);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-sideBar-background, #0f1115);
        --panel: var(--vscode-editor-background, #111318);
        --panel-2: color-mix(in srgb, var(--panel) 86%, white 14%);
        --panel-3: color-mix(in srgb, var(--panel) 78%, white 22%);
        --fg: var(--vscode-foreground, #f3f4f6);
        --muted: var(--vscode-descriptionForeground, #a1a1aa);
        --line: var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
        --accent: var(--vscode-textLink-foreground, #f5f5f5);
        --user: #2f2611;
        --user-line: #5f4b13;
        --good: var(--vscode-testing-iconPassed, #4ade80);
        --bad: var(--vscode-testing-iconFailed, #fb7185);
        --mono: var(--vscode-editor-font-family, "SFMono-Regular", ui-monospace, monospace);
      }
      * { box-sizing: border-box; }
      html { height: 100%; overflow: hidden; }
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: var(--bg);
        color: var(--fg);
        font: 13px/1.5 var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
      }
      button, textarea {
        font: inherit;
      }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto auto;
        height: 100vh;
        overflow: hidden;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--bg) 88%, black 12%);
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .sub {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--muted);
      }
      .dot.ready { background: var(--good); }
      .dot.starting, .dot.reconnecting { background: #f59e0b; }
      .dot.down { background: var(--bad); }
      .btns, .acts {
        display: flex;
        gap: 8px;
      }
      button {
        border: 1px solid var(--line);
        background: transparent;
        color: inherit;
        padding: 8px 12px;
        border-radius: 10px;
        cursor: pointer;
      }
      button.primary {
        background: rgba(255, 255, 255, 0.04);
      }
      .feed {
        min-height: 0;
        overflow: auto;
        padding: 18px 16px 20px;
        display: grid;
        align-content: start;
        gap: 18px;
      }
      .empty {
        color: var(--muted);
        padding: 18px 0;
      }
      .turn {
        display: grid;
        gap: 8px;
      }
      .turn.user {
        justify-items: end;
      }
      .who {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .turn.user .who {
        justify-content: flex-end;
      }
      .bubble {
        width: min(100%, 820px);
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 16px;
        padding: 12px 14px;
      }
      .turn.user .bubble {
        max-width: 82%;
        background: var(--user);
        border-color: var(--user-line);
      }
      .turn.assistant .bubble {
        max-width: 100%;
      }
      .blocks {
        display: grid;
        gap: 12px;
      }
      .block.text {
        white-space: pre-wrap;
        font-size: 14px;
        line-height: 1.7;
      }
      .block.meta {
        color: var(--muted);
        font-size: 12px;
      }
      .err {
        color: var(--bad);
        font-size: 12px;
      }
      .spin {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.12);
        border-top-color: var(--fg);
        animation: spin 0.8s linear infinite;
      }
      .review {
        border-top: 1px solid var(--line);
        padding: 12px 16px;
        display: grid;
        gap: 10px;
        background: color-mix(in srgb, var(--bg) 92%, black 8%);
        max-height: 32vh;
        overflow: auto;
      }
      .review[hidden] {
        display: none;
      }
      .review-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .review-title {
        font-size: 12px;
        color: var(--muted);
      }
      .files {
        display: grid;
        gap: 8px;
      }
      .file {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .file-main {
        min-width: 0;
      }
      .path {
        font-family: var(--mono);
        font-size: 12px;
        word-break: break-word;
      }
      .meta-line {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .composer {
        flex-shrink: 0;
        border-top: 1px solid var(--line);
        padding: 12px 16px 16px;
        background: color-mix(in srgb, var(--bg) 90%, black 10%);
        display: grid;
        gap: 10px;
      }
      textarea {
        width: 100%;
        min-height: 84px;
        resize: vertical;
        border: 1px solid var(--line);
        background: var(--panel);
        color: inherit;
        border-radius: 10px;
        padding: 12px;
      }
      textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--accent) 24%, var(--line));
      }
      .composer-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .hint {
        color: var(--muted);
        font-size: 11px;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="top">
        <div>
          <div class="title" id="title">opencode v2</div>
          <div class="sub" id="sub">Loading workspace…</div>
        </div>
        <div class="btns">
          <div class="status">
            <div class="dot" id="dot"></div>
            <div class="sub" id="conn">Idle</div>
          </div>
          <button id="start">New Session</button>
          <button id="review">Review</button>
        </div>
      </section>
      <section class="feed" id="feed">
        <div class="empty">Loading chat…</div>
      </section>
      <section class="review" id="review-box" hidden>
        <div class="review-head">
          <div class="review-title" id="review-title">0 file changes</div>
          <button id="review-more">Open Review</button>
        </div>
        <div class="files" id="files"></div>
      </section>
      <section class="composer">
        <textarea id="input" placeholder="Ask about this codebase"></textarea>
        <div class="composer-foot">
          <div class="tag">Cmd/Ctrl + Enter to send</div>
          <button class="primary" id="send">Send</button>
        </div>
      </section>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi()
      const q = (id) => document.getElementById(id)
      const esc = (value) =>
        value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
      const app = {
        stick: true,
        state: undefined,
      }
      const feed = q("feed")
      const line = (value) => esc(value).replaceAll("\\n", "<br />")
      const conn = (value) => {
        if (value === "ready") return "Connected"
        if (value === "starting") return "Starting"
        if (value === "reconnecting") return "Reconnecting"
        if (value === "down") return "Disconnected"
        return "Idle"
      }
      const who = (msg) => msg.role === "user" ? "You" : "opencode"
      const part = (item) => {
        if (item.kind === "text") return '<div class="block text">' + line(item.text) + '</div>'
        return '<div class="block meta">' + line(item.text) + '</div>'
      }
      const turn = (msg) => {
        const body = msg.parts.length ? msg.parts.map(part).join("") : '<div class="block meta">Waiting for content…</div>'
        const spin = msg.pending ? '<div class="spin" aria-hidden="true"></div>' : ""
        const err = msg.error ? '<div class="err">' + line(msg.error) + '</div>' : ""
        return (
          '<article class="turn ' + esc(msg.role) + '">' +
          '<div class="who">' + spin + '<span>' + who(msg) + '</span></div>' +
          '<div class="bubble"><div class="blocks">' + body + err + '</div></div>' +
          '</article>'
        )
      }
      const file = (item, folder) => {
        return (
          '<article class="file">' +
          '<div class="file-main">' +
          '<div class="path">' + esc(item.file) + '</div>' +
          '<div class="meta-line">' + esc(item.kind + '  +' + item.add + '  -' + item.del) + '</div>' +
          '</div>' +
          '<div class="acts">' +
          '<button data-act="review" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Review</button>' +
          '<button data-act="apply" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Apply</button>' +
          '<button data-act="reject" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Reject</button>' +
          '</div>' +
          '</article>'
        )
      }
      const end = () => {
        requestAnimationFrame(() => {
          feed.scrollTop = feed.scrollHeight
        })
      }
      const draw = (state) => {
        const prev = app.state
        app.state = state
        q("dot").className = "dot " + state.conn
        q("conn").textContent = conn(state.conn)
        if (!state.hasWorkspace) {
          q("title").textContent = "opencode v2"
          q("sub").textContent = "Open a workspace to start"
          feed.innerHTML = '<div class="empty">No workspace folder is available.</div>'
          q("review-box").hidden = true
          return
        }
        if (!state.box) {
          q("title").textContent = "opencode v2"
          q("sub").textContent = "Select a workspace file to scope the session"
          feed.innerHTML = '<div class="empty">No active folder is selected.</div>'
          q("review-box").hidden = true
          return
        }
        const label = state.box.title || state.box.sid || "New session"
        q("title").textContent = label
        q("sub").textContent = state.box.name + " · " + state.box.stat
        feed.innerHTML = state.box.msg.length
          ? state.box.msg.map(turn).join("")
          : '<div class="empty">Start a session and send a prompt.</div>'
        q("review-box").hidden = state.box.diff.length === 0
        q("review-title").textContent =
          state.box.diff.length === 1 ? "1 file change" : state.box.diff.length + " file changes"
        q("files").innerHTML = state.box.diff.map((item) => file(item, state.box.folder)).join("")
        const follow =
          app.stick ||
          prev?.box?.sid !== state.box.sid ||
          (prev?.box?.msg.length || 0) !== state.box.msg.length
        if (follow) end()
      }
      window.addEventListener("message", (event) => {
        if (event.data?.type === "state") draw(event.data.data)
      })
      feed.addEventListener("scroll", () => {
        app.stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 24
      })
      q("send").addEventListener("click", () => {
        const text = q("input").value
        if (!text.trim()) return
        vscode.postMessage({ type: "prompt", text })
        q("input").value = ""
        app.stick = true
        end()
      })
      q("input").addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault()
          q("send").click()
        }
      })
      q("start").addEventListener("click", () => vscode.postMessage({ type: "start" }))
      q("review").addEventListener("click", () => vscode.postMessage({ type: "review" }))
      q("review-more").addEventListener("click", () => vscode.postMessage({ type: "review" }))
      document.addEventListener("click", (event) => {
        const node = event.target
        if (!(node instanceof HTMLElement)) return
        const act = node.dataset.act
        const file = node.dataset.file
        if (!act || !file) return
        vscode.postMessage({ type: "file", act, file, folder: node.dataset.folder })
      })
      vscode.postMessage({ type: "ready" })
    </script>
  </body>
</html>`;
  }

  private async ensure() {
    if (this.client) {return this.client;}
    if (this.boot) {return this.boot;}

    this.conn = "starting";
    this.note = "Starting local server";
    this.draw();

    this.boot = (async () => {
      const port = await free();
      const bin = this.cfg().get("cliPath", "opencode");
      const proc = spawn(bin, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
        env: {
          ...process.env,
          OPENCODE_CALLER: "vscode-v2",
        },
      });

      const url = `http://127.0.0.1:${port}`;
      const log = (kind: "stdout" | "stderr", chunk: Uint8Array) => {
        if (!this.cfg().get("trace.server", false)) {return;}
        this.out.appendLine(`[${kind}] ${Buffer.from(chunk).toString("utf8").trimEnd()}`);
      };

      proc.stdout.on("data", (chunk) => log("stdout", chunk));
      proc.stderr.on("data", (chunk) => log("stderr", chunk));
      proc.on("exit", (code, signal) => {
        if (this.proc !== proc) {return;}
        this.proc = undefined;
        this.client = undefined;
        this.url = undefined;
        this.evt?.abort();
        this.live = false;
        this.conn = "down";
        this.note = signal ? `Server exited (${signal})` : `Server exited (${code ?? "unknown"})`;
        for (const box of this.map.values()) {
          box.diff = [];
        }
        this.draw();
      });

      await ready(url, proc);

      this.proc = proc;
      this.url = url;
      this.client = createOpencodeClient({
        baseUrl: url,
        throwOnError: true,
      });
      this.conn = "ready";
      this.note = url;
      this.watch();
      this.draw();
      return this.client;
    })().finally(() => {
      this.boot = undefined;
    });

    return this.boot;
  }

  private watch() {
    if (!this.client || this.loop) {return;}
    const ctl = new AbortController();
    this.evt = ctl;
    this.loop = (async () => {
      while (!ctl.signal.aborted) {
        const stream = await this.client!
          .event.subscribe(undefined, {
            signal: ctl.signal,
          })
          .then((res) => res.stream)
          .catch(async (err) => {
            if (ctl.signal.aborted) {return;}
            this.live = false;
            this.conn = "reconnecting";
            this.note = err instanceof Error ? err.message : "Event stream failed";
            this.draw();
            await wait(1000);
            return;
          });

        if (!stream) {continue;}
        const cold = !this.live;
        this.live = true;
        this.conn = "ready";
        this.note = this.url ?? "Connected";
        if (cold) {
          for (const box of this.map.values()) {
            if (!box.cold) {continue;}
            box.cold = false;
            this.mark(box, { msg: true, diff: true, sess: true, stat: true });
          }
        }
        this.draw();
        await (async () => {
          for await (const event of stream) {
            await this.event(event);
          }
        })().catch(async (err) => {
          if (ctl.signal.aborted) {return;}
          this.live = false;
          this.conn = "reconnecting";
          this.note = err instanceof Error ? err.message : "Event stream failed";
          this.draw();
          await wait(1000);
        });
      }
    })().finally(() => {
      if (this.evt === ctl) {this.evt = undefined;}
      if (!ctl.signal.aborted) {this.live = false;}
      this.loop = undefined;
    });
  }

  private async make(dir: vscode.WorkspaceFolder) {
    const box = this.box(dir);
    if (!box) {return;}
    if (box.sid) {
      await this.sync(dir, { sess: true, msg: true, diff: true, stat: true });
      return box.sid;
    }

    const sid = this.ids[this.key(dir)];
    if (sid) {
      box.sid = sid;
      this.bySid.set(sid, this.key(dir));
      const ok = await this.sync(dir, { sess: true, msg: true, diff: true, stat: true });
      if (ok && box.sid === sid) {return sid;}
      this.drop(box);
    }

    const client = await this.ensure();
    const data = await client.session.create({ directory: dir.uri.fsPath }).then((res) => res.data);
    if (!data) {throw new Error("Failed to create session");}
    box.sid = data.id;
    box.sess = data;
    box.msg = [];
    box.stat = "idle";
    this.bySid.set(data.id, this.key(dir));
    this.ids[this.key(dir)] = data.id;
    await this.ctx.workspaceState.update(STORE, this.ids);
    this.draw();
    return data.id;
  }

  private async post(
    dir: vscode.WorkspaceFolder,
    body: {
      noReply?: boolean
      parts: InPart[]
    },
  ) {
    const box = this.box(dir);
    if (!box) {return;}
    const sid = await this.make(dir);
    if (!sid) {return;}
    const client = await this.ensure();
    const input = this.optimistic(box, sid, body.parts);
    box.stat = "busy";
    box.err = undefined;
    box.cold = !this.live;
    this.draw();
    await client.session
      .promptAsync({
        sessionID: sid,
        directory: dir.uri.fsPath,
        messageID: input.id,
        noReply: body.noReply,
        parts: input.parts,
      })
      .catch((err) => {
        this.cut(box, input.id);
        box.err = err instanceof Error ? err.message : String(err);
        box.stat = "error";
        this.draw();
        throw err;
      });
    if (body.noReply) {
      box.stat = "idle";
      box.cold = false;
      this.mark(box, { msg: true, sess: true, stat: true });
      this.draw();
      return;
    }
    if (box.cold) {
      this.mark(box, { msg: true, diff: true, sess: true, stat: true });
    }
  }

  private mark(box: BoxState, next: Partial<Wait>) {
    box.wait.msg ||= next.msg;
    box.wait.diff ||= next.diff;
    box.wait.sess ||= next.sess;
    box.wait.stat ||= next.stat;
    if (box.wait.id) {return;}
    box.wait.id = setTimeout(() => {
      box.wait.id = undefined;
      const run = {
        msg: Boolean(box.wait.msg),
        diff: Boolean(box.wait.diff),
        sess: Boolean(box.wait.sess),
        stat: Boolean(box.wait.stat),
      };
      box.wait.msg = false;
      box.wait.diff = false;
      box.wait.sess = false;
      box.wait.stat = false;
      void this.sync(box.dir, run);
    }, 150);
  }

  private async sync(dir: vscode.WorkspaceFolder, next: { msg?: boolean; diff?: boolean; sess?: boolean; stat?: boolean }) {
    const box = this.box(dir);
    if (!box?.sid) {return false;}
    const client = await this.ensure();
    const sid = box.sid;
    const work = [
      next.sess
        ? client.session
            .get({ sessionID: sid, directory: dir.uri.fsPath })
            .then((res) => {
              box.sess = res.data;
            })
            .catch((err) => {
              if (gone(err)) {this.drop(box);}
              else {box.err = err instanceof Error ? err.message : String(err);}
            })
        : Promise.resolve(),
      next.msg
        ? client.session
            .messages({ sessionID: sid, directory: dir.uri.fsPath, limit: 100 })
            .then((res) => {
              this.merge(box, res.data ?? []);
            })
            .catch((err) => {
              box.err = err instanceof Error ? err.message : String(err);
            })
        : Promise.resolve(),
      next.diff
        ? client.session
            .diff({ sessionID: sid, directory: dir.uri.fsPath })
            .then((res) => this.set(box, res.data ?? []))
            .catch((err) => {
              box.err = err instanceof Error ? err.message : String(err);
            })
        : Promise.resolve(),
      next.stat
        ? client.session
            .status({ directory: dir.uri.fsPath })
            .then((res) => {
              const stat = res.data?.[sid];
              if (!stat) {
                box.stat = "idle";
                return;
              }
              box.stat = this.state(stat);
              box.err = undefined;
            })
            .catch((err) => {
              box.err = err instanceof Error ? err.message : String(err);
            })
        : Promise.resolve(),
    ];
    await Promise.all(work);
    this.draw();
    return Boolean(box.sid && box.sess);
  }

  private async set(box: BoxState, list: FileDiff[]) {
    const prev = box.diff.flatMap((item) => [item.base, item.next]);
    const next = await Promise.all(
      list.map(async (item) => {
        const uri = this.uri(box.dir, item.file);
        const text = await this.read(uri);
        const kind =
          item.before === "" && text === undefined ? "added" : item.after === "" && text === item.before ? "deleted" : "modified";
        const sid = box.sid ?? "session";
        const query = new URLSearchParams({ sid, file: item.file }).toString();
        const base = uri.with({ scheme: BASE, query });
        const n = uri.with({ scheme: NEXT, query });
        this.docs.set(base, item.before);
        this.docs.set(n, item.after);
        return {
          ...item,
          uri,
          base,
          next: n,
          kind,
        } satisfies Diff;
      }),
    );

    const live = new Set(next.flatMap((item) => [item.base.toString(), item.next.toString()]));
    for (const uri of prev) {
      if (live.has(uri.toString())) {continue;}
      this.docs.del(uri);
    }

    box.diff = next;
    this.draw();

    const key = this.stamp(next);
    if (!this.cfg().get("openDiffOnChange", false)) {return;}
    if (this.auto.get(this.key(box.dir)) === key) {return;}
    if (this.scope()?.uri.toString() !== box.dir.uri.toString()) {return;}
    this.auto.set(this.key(box.dir), key);
    if (next.length > 0) {void this.review({ folder: this.key(box.dir) });}
  }

  private stamp(list: Diff[]) {
    return list
      .map((item) => `${item.file}:${item.additions}:${item.deletions}:${item.kind}`)
      .sort()
      .join("|");
  }

  private async event(event: Event) {
    const box = this.find(event);
    if (!box) {return;}

    if (event.type === "session.created" || event.type === "session.updated") {
      box.sess = event.properties.info;
      box.sid = event.properties.info.id;
      this.bySid.set(event.properties.info.id, this.key(box.dir));
      this.ids[this.key(box.dir)] = event.properties.info.id;
      await this.ctx.workspaceState.update(STORE, this.ids);
      this.draw();
      return;
    }

    if (event.type === "session.deleted") {
      this.drop(box);
      this.draw();
      return;
    }

    if (event.type === "session.diff") {
      await this.set(box, event.properties.diff);
      return;
    }

    if (event.type === "session.status") {
      box.stat = this.state(event.properties.status);
      box.err = undefined;
      this.draw();
      return;
    }

    if (event.type === "session.idle") {
      box.stat = "idle";
      box.cold = false;
      this.draw();
      return;
    }

    if (event.type === "session.error") {
      const msg = event.properties.error?.data;
      box.err = msg && typeof msg === "object" && "message" in msg && typeof msg.message === "string" ? msg.message : "Unknown session error";
      box.stat = "error";
      box.cold = false;
      this.draw();
      return;
    }

    if (event.type === "message.updated") {
      this.put(box, event.properties.info);
      this.draw();
      return;
    }

    if (event.type === "message.removed") {
      this.cut(box, event.properties.messageID);
      this.draw();
      return;
    }

    if (event.type === "message.part.updated") {
      this.add(box, event.properties.part);
      this.draw();
      return;
    }

    if (event.type === "message.part.delta") {
      if (!this.delta(box, event.properties)) {
        this.mark(box, { msg: true });
      }
      this.draw();
      return;
    }

    if (event.type === "message.part.removed") {
      this.dropPart(box, event.properties);
      this.draw();
      return;
    }

    if (
      event.type === "question.asked" ||
      event.type === "question.replied" ||
      event.type === "question.rejected" ||
      event.type === "permission.asked" ||
      event.type === "permission.replied"
    ) {
      this.mark(box, { msg: true, sess: true, stat: true });
    }
  }

  private state(stat: SessionStatus) {
    if (stat.type === "retry") {return `retry ${stat.attempt}: ${stat.message}`;}
    return stat.type;
  }

  private find(event: Event) {
    const sid =
      event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted"
        ? event.properties.info.id
        : event.type === "session.diff" ||
            event.type === "session.error" ||
            event.type === "session.idle" ||
            event.type === "session.status"
          ? event.properties.sessionID
          : event.type === "message.updated"
            ? event.properties.info.sessionID
            : event.type === "message.removed" ||
                event.type === "message.part.delta" ||
                event.type === "question.asked" ||
                event.type === "question.replied" ||
                event.type === "question.rejected" ||
                event.type === "permission.asked" ||
                event.type === "permission.replied"
              ? event.properties.sessionID
              : event.type === "message.part.updated"
                ? event.properties.part.sessionID
                : event.type === "message.part.removed"
                  ? event.properties.sessionID
                  : undefined;

    if (!sid) {return;}
    const key = this.bySid.get(sid);
    return key ? this.map.get(key) : undefined;
  }

  private drop(box: BoxState) {
    const key = this.key(box.dir);
    if (box.sid) {this.bySid.delete(box.sid);}
    delete this.ids[key];
    box.sid = undefined;
    box.sess = undefined;
    box.msg = [];
    box.diff.forEach((item) => {
      this.docs.del(item.base);
      this.docs.del(item.next);
    });
    box.diff = [];
    box.err = undefined;
    box.stat = "idle";
    void this.ctx.workspaceState.update(STORE, this.ids);
  }

  remove(dir: vscode.WorkspaceFolder) {
    const key = dir.uri.toString();
    const box = this.target(key);
    if (!box) {return;}
    this.drop(box);
    this.map.delete(key);
  }

  private async file(box: BoxState, file?: string) {
    if (box.diff.length === 0) {
      void vscode.window.showInformationMessage("No file changes are available for the current opencode v2 session.");
      return;
    }

    if (file) {
      const hit = box.diff.find((item) => item.file === file);
      if (hit) {return hit;}
    }

    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const hit = box.diff.find((item) => same(item.uri, uri));
      if (hit) {return hit;}
    }

    const pick = await vscode.window.showQuickPick(
      box.diff.map((item) => ({
        label: this.label(box, item),
        description: `${item.kind}  +${item.additions}  -${item.deletions}`,
        item,
      })),
      {
        placeHolder: "Select an opencode v2 file change",
      },
    );
    return pick?.item;
  }

  private async write(box: BoxState, item: Diff, act: "apply" | "reject") {
    const want = act === "apply" ? item.after : item.before;
    const need = act === "apply" ? item.before : item.after;
    const doc = await this.openDoc(item.uri);
    if (doc?.isDirty) {
      const pick = await vscode.window.showWarningMessage(
        `${this.label(box, item)} has unsaved changes.`,
        { modal: true },
        "Save",
        "Continue",
      );
      if (!pick) {return;}
      if (pick === "Save") {
        const ok = await doc.save();
        if (!ok) {return;}
      }
    }

    const text = doc ? doc.getText() : await this.read(item.uri);
    const miss = text === undefined && need === "" && ((act === "apply" && item.kind === "added") || (act === "reject" && item.kind === "deleted"));
    if (text !== need && !miss) {
      void vscode.window.showErrorMessage(
        `${act === "apply" ? "Apply" : "Reject"} blocked because ${this.label(box, item)} no longer matches the expected ${act === "apply" ? "base" : "proposed"} content.`,
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const del = (act === "apply" && item.kind === "deleted") || (act === "reject" && item.kind === "added");
    if (del) {
      edit.deleteFile(item.uri, { ignoreIfNotExists: false });
    } else if (!doc) {
      edit.createFile(item.uri, { ignoreIfExists: false });
      edit.insert(item.uri, new vscode.Position(0, 0), want);
    } else {
      edit.replace(item.uri, whole(doc), want);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage(`Failed to ${act} ${this.label(box, item)}.`);
      return;
    }

    void vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
  }

  private async openDoc(uri: vscode.Uri) {
    return Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => undefined);
  }

  private async read(uri: vscode.Uri) {
    return this.openDoc(uri).then((doc) => doc?.getText());
  }
}

function whole(doc: vscode.TextDocument) {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

function same(a: vscode.Uri, b: vscode.Uri) {
  return a.toString() === b.toString();
}

function cmp(a: string, b: string) {
  if (a < b) {return -1;}
  if (a > b) {return 1;}
  return 0;
}

function insertMsg(list: Msg[], item: Msg) {
  const at = list.findIndex((entry) => cmp(entry.info.id, item.info.id) > 0);
  if (at === -1) {
    list.push(item);
    return;
  }
  list.splice(at, 0, item);
}

function insertPart(list: Part[], part: Part) {
  const at = list.findIndex((entry) => cmp(entry.id, part.id) > 0);
  if (at === -1) {
    list.push(part);
    return;
  }
  list.splice(at, 0, part);
}

function cloneMsg(msg: Msg) {
  return {
    info: structuredClone(msg.info),
    parts: msg.parts.map((part) => structuredClone(part)),
    opt: msg.opt,
  } satisfies Msg;
}

function wait(ms: number) {
  return new Promise<void>((done) => setTimeout(done, ms));
}

function gone(err: unknown) {
  return err instanceof Error && /404|not found/i.test(err.message);
}

async function free() {
  const srv = createServer();
  await new Promise<void>((done, fail) => {
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => done());
  });
  const addr = srv.address();
  await new Promise<void>((done, fail) => srv.close((err) => (err ? fail(err) : done())));
  if (!addr || typeof addr === "string") {throw new Error("Failed to allocate port");}
  return addr.port;
}

async function ready(url: string, proc: ChildProcessWithoutNullStreams) {
  const end = Date.now() + 10_000;
  let err: Error | undefined;
  proc.once("error", (next) => {
    err = next;
  });
  while (Date.now() < end) {
    if (err) {throw err;}
    const exit = proc.exitCode;
    if (exit !== null) {throw new Error(`Server exited with code ${exit}`);}
    const ok = await fetch(`${url}/project`).then((res) => res.ok, () => false);
    if (ok) {return;}
    await wait(125);
  }
  throw new Error("Timed out waiting for opencode serve to become ready");
}

const prefix = {
  message: "msg",
  part: "prt",
} as const;

let last = 0;
let count = 0;

function token(kind: keyof typeof prefix) {
  const now = Date.now();
  if (now !== last) {
    last = now;
    count = 0;
  }
  count += 1;

  const mark = BigInt(now) * BigInt(0x1000) + BigInt(count);
  const time = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    time[i] = Number((mark >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix[kind]}_${hex(time)}${rand(14)}`;
}

function hex(data: Uint8Array) {
  let out = "";
  for (let i = 0; i < data.length; i++) {
    out += data[i].toString(16).padStart(2, "0");
  }
  return out;
}

function rand(size: number) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const data = randomBytes(size);
  let out = "";
  for (let i = 0; i < data.length; i++) {
    out += chars[data[i] % 62];
  }
  return out;
}

function webviewHtml(nonce: string, csp: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: color-mix(in srgb, var(--vscode-sideBar-background, #0f1115) 92%, black 8%);
        --panel: color-mix(in srgb, var(--vscode-editor-background, #111318) 92%, white 8%);
        --panel-2: color-mix(in srgb, var(--panel) 90%, white 10%);
        --panel-3: color-mix(in srgb, var(--panel) 78%, white 22%);
        --fg: var(--vscode-foreground, #f3f4f6);
        --muted: var(--vscode-descriptionForeground, #a1a1aa);
        --line: var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
        --accent: var(--vscode-textLink-foreground, #dbeafe);
        --user: color-mix(in srgb, #c084fc 10%, var(--panel) 90%);
        --user-line: color-mix(in srgb, #c084fc 42%, var(--line));
        --good: var(--vscode-testing-iconPassed, #4ade80);
        --bad: var(--vscode-testing-iconFailed, #fb7185);
        --shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
        --mono: var(--vscode-editor-font-family, "SFMono-Regular", ui-monospace, monospace);
      }
      * { box-sizing: border-box; }
      html { height: 100%; overflow: hidden; }
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: var(--bg);
        color: var(--fg);
        font: 13px/1.5 var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
      }
      button, textarea {
        font: inherit;
      }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        height: 100vh;
        overflow: hidden;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 16px 14px;
        border-bottom: 1px solid var(--line);
        background:
          radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 10%, transparent) 0, transparent 48%),
          color-mix(in srgb, var(--bg) 88%, black 12%);
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .sub {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--muted);
      }
      .dot.ready { background: var(--good); }
      .dot.starting, .dot.reconnecting { background: #f59e0b; }
      .dot.down { background: var(--bad); }
      .btns, .acts {
        display: flex;
        gap: 8px;
      }
      button {
        border: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel) 74%, transparent);
        color: inherit;
        padding: 8px 12px;
        border-radius: 12px;
        cursor: pointer;
        transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
      }
      button:hover:enabled {
        border-color: color-mix(in srgb, var(--accent) 28%, var(--line));
        background: color-mix(in srgb, var(--panel-2) 88%, var(--accent) 12%);
        transform: translateY(-1px);
      }
      button:disabled {
        cursor: default;
        opacity: 0.5;
      }
      button.primary {
        background: color-mix(in srgb, var(--accent) 16%, var(--panel));
      }
      .thread {
        min-height: 0;
        overflow: auto;
        padding: 18px 16px 26px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, black 8%) 0%, var(--bg) 28%),
          var(--bg);
      }
      .feed {
        display: grid;
        align-content: start;
        gap: 20px;
      }
      .empty {
        color: var(--muted);
        padding: 22px 6px;
        max-width: 520px;
      }
      .turn {
        display: grid;
        gap: 14px;
      }
      .turn-main {
        display: grid;
        gap: 10px;
      }
      .reply {
        display: grid;
        gap: 8px;
      }
      .reply.user {
        justify-items: end;
      }
      .who {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .reply.user .who {
        justify-content: flex-end;
      }
      .card {
        width: min(100%, 820px);
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 14px 15px;
        box-shadow: var(--shadow);
      }
      .card.user {
        max-width: 82%;
        background: var(--user);
        border-color: var(--user-line);
      }
      .parts {
        display: grid;
        gap: 12px;
      }
      .part {
        display: grid;
        gap: 8px;
        border: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel-2) 92%, transparent);
        border-radius: 16px;
        padding: 12px;
      }
      .card.user .part {
        background: transparent;
        border-color: color-mix(in srgb, var(--user-line) 72%, var(--line));
      }
      .part.text {
        border: none;
        background: transparent;
        padding: 0;
      }
      .part.reasoning {
        border-style: dashed;
      }
      .part.tool {
        background: color-mix(in srgb, var(--panel-3) 90%, transparent);
      }
      .part.file {
        background: color-mix(in srgb, var(--panel) 86%, white 14%);
      }
      .part.meta {
        background: color-mix(in srgb, var(--panel) 90%, transparent);
      }
      .part-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .part-head {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .part-title {
        min-width: 0;
        font-weight: 600;
      }
      .part-body {
        white-space: pre-wrap;
        font-size: 14px;
        line-height: 1.65;
        word-break: break-word;
      }
      .part-copy {
        color: var(--muted);
        font-size: 12px;
        white-space: pre-wrap;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        border: 1px solid var(--line);
        padding: 3px 8px;
        font-size: 11px;
        color: var(--muted);
      }
      .pill.live {
        color: var(--accent);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
      }
      .pill.done {
        color: var(--good);
        border-color: color-mix(in srgb, var(--good) 30%, var(--line));
      }
      .pill.fail {
        color: var(--bad);
        border-color: color-mix(in srgb, var(--bad) 30%, var(--line));
      }
      .err {
        color: var(--bad);
        font-size: 12px;
        white-space: pre-wrap;
      }
      .spin {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.12);
        border-top-color: var(--fg);
        animation: spin 0.8s linear infinite;
      }
      .thinking {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 10px;
        padding: 6px 4px 0;
        color: var(--muted);
      }
      .thinking-copy {
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .diffs {
        display: grid;
        gap: 10px;
      }
      .diffs-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .diffs-title {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .diffs-list {
        display: grid;
        gap: 10px;
      }
      .diff {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        border-radius: 16px;
        padding: 12px;
      }
      .diff-main {
        min-width: 0;
        flex: 1 1 220px;
      }
      .path {
        font-family: var(--mono);
        font-size: 12px;
        word-break: break-word;
      }
      .meta-line {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .composer {
        flex-shrink: 0;
        border-top: 1px solid var(--line);
        padding: 12px 16px 16px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--bg) 72%, transparent) 0%, color-mix(in srgb, var(--bg) 94%, black 6%) 100%),
          color-mix(in srgb, var(--bg) 90%, black 10%);
        display: grid;
        gap: 10px;
      }
      textarea {
        width: 100%;
        min-height: 84px;
        resize: vertical;
        border: 1px solid var(--line);
        background: var(--panel);
        color: inherit;
        border-radius: 12px;
        padding: 12px;
      }
      textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--accent) 24%, var(--line));
      }
      .composer-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="top">
        <div>
          <div class="title" id="title">opencode v2</div>
          <div class="sub" id="sub">Loading workspace…</div>
        </div>
        <div class="btns">
          <div class="status">
            <div class="dot" id="dot"></div>
            <div class="sub" id="conn">Idle</div>
          </div>
          <button id="start">New Session</button>
          <button id="review">Review</button>
        </div>
      </section>
      <section class="thread" id="thread">
        <div class="feed" id="feed">
          <div class="empty">Loading chat…</div>
        </div>
      </section>
      <section class="composer">
        <textarea id="input" placeholder="Ask about this codebase"></textarea>
        <div class="composer-foot">
          <div class="tag">Cmd/Ctrl + Enter to send</div>
          <button class="primary" id="send">Send</button>
        </div>
      </section>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi()
      const q = (id) => document.getElementById(id)
      const esc = (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
      const make = (html) => {
        const tpl = document.createElement("template")
        tpl.innerHTML = html.trim()
        return tpl.content.firstElementChild
      }
      const app = {
        stick: true,
        state: undefined,
      }
      const feed = q("feed")
      const thread = q("thread")
      const line = (value) => esc(value).replaceAll("\\n", "<br />")
      const conn = (value) => {
        if (value === "ready") return "Connected"
        if (value === "starting") return "Starting"
        if (value === "reconnecting") return "Reconnecting"
        if (value === "down") return "Disconnected"
        return "Idle"
      }
      const who = (msg) => msg.role === "user" ? "You" : "opencode"
      const badge = (msg) => {
        if (msg.opt) return '<span class="pill live">Sending</span>'
        if (msg.pending) return '<span class="pill live">Streaming</span>'
        return ""
      }
      const part = (item) => {
        if (item.kind === "text") {
          return '<div class="part text"><div class="part-body">' + line(item.text || "") + '</div></div>'
        }
        if (item.kind === "reasoning") {
          return (
            '<div class="part reasoning">' +
            '<div class="part-top"><div class="part-head">' + esc(item.title || "Thinking") + '</div></div>' +
            '<div class="part-body">' + line(item.text || "") + '</div>' +
            '</div>'
          )
        }
        if (item.kind === "tool") {
          const tone =
            item.status === "completed"
              ? "done"
              : item.status === "error"
                ? "fail"
                : "live"
          const body = item.text ? '<div class="part-body">' + line(item.text) + '</div>' : ""
          return (
            '<div class="part tool">' +
            '<div class="part-top">' +
            '<div><div class="part-head">' + esc(item.tool || "Tool") + '</div><div class="part-title">' + esc(item.title || item.tool || "Tool") + '</div></div>' +
            '<span class="pill ' + esc(tone) + '">' + esc(item.status || "pending") + '</span>' +
            '</div>' +
            body +
            '</div>'
          )
        }
        if (item.kind === "file") {
          return (
            '<div class="part file">' +
            '<div class="part-top"><div><div class="part-head">Attachment</div><div class="part-title">' + esc(item.title || "File") + '</div></div></div>' +
            (item.text ? '<div class="part-copy">' + esc(item.text) + '</div>' : "") +
            '</div>'
          )
        }
        return (
          '<div class="part meta">' +
          '<div class="part-top"><div><div class="part-head">' + esc(item.title || "Update") + '</div></div></div>' +
          (item.text ? '<div class="part-copy">' + line(item.text) + '</div>' : "") +
          '</div>'
        )
      }
      const reply = (msg) => {
        const body = msg.parts.length ? msg.parts.map(part).join("") : ""
        const err = msg.error ? '<div class="err">' + line(msg.error) + '</div>' : ""
        return (
          '<article class="reply ' + esc(msg.role) + '">' +
          '<div class="who">' + badge(msg) + '<span>' + who(msg) + '</span></div>' +
          '<div class="card ' + esc(msg.role) + '"><div class="parts">' + body + err + '</div></div>' +
          '</article>'
        )
      }
      const diff = (item, folder) => {
        return (
          '<article class="diff">' +
          '<div class="diff-main">' +
          '<div class="path">' + esc(item.file) + '</div>' +
          '<div class="meta-line">' + esc(item.kind + '  +' + item.add + '  -' + item.del) + '</div>' +
          '</div>' +
          '<div class="acts">' +
          '<button data-act="review" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Review</button>' +
          '<button data-act="apply" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Apply</button>' +
          '<button data-act="reject" data-file="' + esc(item.file) + '" data-folder="' + esc(folder) + '">Reject</button>' +
          '</div>' +
          '</article>'
        )
      }
      const thinking = () => {
        return (
          '<div class="thinking">' +
          '<div class="spin" aria-hidden="true"></div>' +
          '<div class="thinking-copy">Thinking…</div>' +
          '</div>'
        )
      }
      const turn = (item, folder, hash) => {
        const diffs = item.diff.length
          ? (
            '<section class="diffs">' +
            '<div class="diffs-head"><div class="diffs-title">' + esc(item.diff.length === 1 ? "1 file change" : item.diff.length + " file changes") + '</div></div>' +
            '<div class="diffs-list">' + item.diff.map((entry) => diff(entry, folder)).join("") + '</div>' +
            '</section>'
          )
          : ""
        return make(
          '<article class="turn' + (item.active ? " active" : "") + '" data-turn="' + esc(item.id) + '" data-hash="' + esc(hash) + '">' +
          '<div class="turn-main">' +
          reply(item.user) +
          item.assistant.map(reply).join("") +
          (item.thinking ? thinking() : "") +
          diffs +
          '</div>' +
          '</article>'
        )
      }
      const stamp = (value) => JSON.stringify(value)
      const empty = (text) => {
        feed.innerHTML = '<div class="empty">' + esc(text) + '</div>'
      }
      const end = () => {
        requestAnimationFrame(() => {
          thread.scrollTop = thread.scrollHeight
        })
      }
      const patch = (state) => {
        const list = state.box.turn
        if (!list.length) {
          empty("Start a session and send a prompt.")
          return
        }
        Array.from(feed.children).forEach((node) => {
          if (node.dataset.turn) return
          node.remove()
        })
        const nodes = new Map(
          Array.from(feed.querySelectorAll("[data-turn]")).map((node) => [node.dataset.turn, node]),
        )
        const seen = new Set()
        list.forEach((item, index) => {
          const hash = stamp(item)
          let node = nodes.get(item.id)
          if (!node || node.dataset.hash !== hash) {
            const next = turn(item, state.box.folder, hash)
            if (node) {
              node.replaceWith(next)
            }
            node = next
          }
          const anchor = feed.children[index]
          if (anchor !== node) {
            feed.insertBefore(node, anchor || null)
          }
          seen.add(item.id)
        })
        nodes.forEach((node, key) => {
          if (seen.has(key)) return
          node.remove()
        })
      }
      const draw = (state) => {
        const prev = app.state
        app.state = state
        q("dot").className = "dot " + state.conn
        q("conn").textContent = conn(state.conn)
        if (!state.hasWorkspace) {
          q("title").textContent = "opencode v2"
          q("sub").textContent = "Open a workspace to start"
          q("review").disabled = true
          empty("No workspace folder is available.")
          return
        }
        if (!state.box) {
          q("title").textContent = "opencode v2"
          q("sub").textContent = "Select a workspace file to scope the session"
          q("review").disabled = true
          empty("No active folder is selected.")
          return
        }
        const label = state.box.title || state.box.sid || "New session"
        q("title").textContent = label
        q("sub").textContent = state.box.name + " · " + state.box.stat
        q("review").disabled = state.box.diff.length === 0
        patch(state)
        const last = state.box.turn[state.box.turn.length - 1]
        const old = prev?.box?.turn
        const earlier = old ? old[old.length - 1] : undefined
        const follow =
          app.stick ||
          prev?.box?.sid !== state.box.sid ||
          (prev?.box?.turn?.length || 0) !== state.box.turn.length ||
          stamp(last) !== stamp(earlier)
        if (follow) end()
      }
      window.addEventListener("message", (event) => {
        if (event.data?.type === "state") draw(event.data.data)
      })
      thread.addEventListener("scroll", () => {
        app.stick = thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 24
      })
      q("send").addEventListener("click", () => {
        const text = q("input").value
        if (!text.trim()) return
        vscode.postMessage({ type: "prompt", text })
        q("input").value = ""
        app.stick = true
        end()
      })
      q("input").addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault()
          q("send").click()
        }
      })
      q("start").addEventListener("click", () => vscode.postMessage({ type: "start" }))
      q("review").addEventListener("click", () => vscode.postMessage({ type: "review" }))
      document.addEventListener("click", (event) => {
        const node = event.target
        if (!(node instanceof HTMLElement)) return
        const act = node.dataset.act
        const file = node.dataset.file
        if (!act || !file) return
        vscode.postMessage({ type: "file", act, file, folder: node.dataset.folder })
      })
      vscode.postMessage({ type: "ready" })
    </script>
  </body>
</html>`;
}

let ext: Ext | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const app = new Ext(ctx);
  ext = app;

  ctx.subscriptions.push(
    app,
    vscode.workspace.registerTextDocumentContentProvider(BASE, app.provider),
    vscode.workspace.registerTextDocumentContentProvider(NEXT, app.provider),
    vscode.window.registerWebviewViewProvider(VIEW, app, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand("opencodeV2.openChat", () => app.open()),
    vscode.commands.registerCommand("opencodeV2.startSession", () => app.start()),
    vscode.commands.registerCommand("opencodeV2.sendSelection", () => app.sendSelection()),
    vscode.commands.registerCommand("opencodeV2.sendFile", () => app.sendFile()),
    vscode.commands.registerCommand("opencodeV2.reviewSession", (arg?: FileArg) => app.review(arg)),
    vscode.commands.registerCommand("opencodeV2.reviewFile", (arg?: FileArg) => app.reviewFile(arg)),
    vscode.commands.registerCommand("opencodeV2.applyFile", (arg?: FileArg) => app.apply(arg)),
    vscode.commands.registerCommand("opencodeV2.rejectFile", (arg?: FileArg) => app.reject(arg)),
    vscode.window.onDidChangeActiveTextEditor(() => app.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const dir of event.removed) {
        app.remove(dir);
      }
      app.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opencodeV2")) {return;}
      app.refresh();
      if (vscode.workspace.getConfiguration("opencodeV2").get("autoStartServer", true) && app.shown) {
        void app.warm();
      }
    }),
  );
}

export function deactivate() {
  ext?.dispose();
  ext = undefined;
}
