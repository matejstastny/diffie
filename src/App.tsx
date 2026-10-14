import BranchIcon from "@material-symbols/svg-400/rounded/account_tree.svg";
import CloseIcon from "@material-symbols/svg-400/rounded/close.svg";
import DescriptionIcon from "@material-symbols/svg-400/rounded/description.svg";
import FolderIcon from "@material-symbols/svg-400/rounded/folder.svg";
import FolderOpenIcon from "@material-symbols/svg-400/rounded/folder_open.svg";
import MoreIcon from "@material-symbols/svg-400/rounded/more_horiz.svg";
import SearchIcon from "@material-symbols/svg-400/rounded/search.svg";
import SwapIcon from "@material-symbols/svg-400/rounded/swap_horiz.svg";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

declare global {
    interface Window {
        __TAURI__?: { core?: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } };
    }
}

type FileStatus = "A" | "M" | "D" | "R" | "C";
type ChangedFile = { status: FileStatus; path: string; previousPath?: string };
type BranchRef = { name: string; scope: "local" | "remote" };
type Repository = { path: string; name: string; branches: BranchRef[]; currentBranch?: string; defaultBase: string };
type Comparison = { base: string; head: string; files: ChangedFile[] };
type FileDiff = { path: string; diff: string; isBinary: boolean; isLarge: boolean; lineCount: number };
type FileContents = { content: string; isBinary: boolean; lineCount: number };
type DiffLine = { number: number; text: string; kind: "context" | "added" | "removed" };
type DiffRow =
    | { kind: "hunk"; label: string }
    | { kind: "line"; old?: DiffLine; next?: DiffLine; change: "context" | "added" | "removed" | "changed" };
type Modal = "files" | "repos" | null;
type TreeNode = { name: string; path: string; children: TreeNode[]; file?: ChangedFile };

const languageByExtension: Record<string, string> = {
    adoc: "asciidoc",
    asm: "armasm",
    bash: "bash",
    c: "c",
    cc: "cpp",
    clj: "clojure",
    cmake: "cmake",
    coffee: "coffeescript",
    conf: "ini",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    cue: "yaml",
    dart: "dart",
    diff: "diff",
    elm: "elm",
    env: "ini",
    ex: "elixir",
    fs: "fsharp",
    go: "go",
    gradle: "gradle",
    groovy: "groovy",
    h: "c",
    haskell: "haskell",
    hpp: "cpp",
    hs: "haskell",
    html: "xml",
    ini: "ini",
    java: "java",
    jl: "julia",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    latex: "latex",
    less: "less",
    lisp: "lisp",
    lock: "json",
    lua: "lua",
    m: "matlab",
    md: "markdown",
    nix: "nix",
    pas: "delphi",
    perl: "perl",
    php: "php",
    pl: "perl",
    properties: "ini",
    proto: "protobuf",
    py: "python",
    qml: "qml",
    r: "r",
    rb: "ruby",
    rs: "rust",
    scala: "scala",
    scss: "scss",
    sh: "bash",
    sol: "solidity",
    sql: "sql",
    swift: "swift",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
};

let highlighterPromise: Promise<typeof import("highlight.js")["default"]> | undefined;
let fileIconPromise: Promise<(filename: string) => string> | undefined;

function loadHighlighter() {
    highlighterPromise ??= import("highlight.js").then(({ default: highlighter }) => highlighter);
    return highlighterPromise;
}

function loadFileIcons() {
    fileIconPromise ??= import("material-file-icons").then(
        ({ getIcon }) =>
            (filename) =>
                getIcon(filename).svg,
    );
    return fileIconPromise;
}

const RECENTS_KEY = "diffie.recent-repositories";
const LOCAL_CHECKOUT = "__diffie_local_checkout__";
const statusInfo: Record<FileStatus, { label: string; mark: string }> = {
    A: { label: "added", mark: "+" },
    M: { label: "modified", mark: "~" },
    D: { label: "deleted", mark: "−" },
    R: { label: "renamed", mark: "↪" },
    C: { label: "copied", mark: "⧉" },
};

function invoke<T>(command: string, args?: Record<string, unknown>) {
    const api = window.__TAURI__?.core?.invoke;
    return api ? api<T>(command, args) : Promise.reject(new Error("Diffie must run as a desktop app."));
}

function rememberRepository(path: string) {
    const old = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as string[];
    localStorage.setItem(RECENTS_KEY, JSON.stringify([path, ...old.filter((item) => item !== path)].slice(0, 8)));
}

function getRecents() {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as string[];
}

export default function App() {
    const [repo, setRepo] = useState<Repository | null>(null);
    const [comparison, setComparison] = useState<Comparison | null>(null);
    const [selected, setSelected] = useState<ChangedFile | null>(null);
    const [diff, setDiff] = useState<FileDiff | null>(null);
    const [wholeFile, setWholeFile] = useState<FileContents | null>(null);
    const [viewMode, setViewMode] = useState<"diff" | "file">("diff");
    const [base, setBase] = useState("");
    const [head, setHead] = useState("");
    const [path, setPath] = useState("");
    const [filter, setFilter] = useState("");
    const [modal, setModal] = useState<Modal>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("Ready");
    const selectedPath = useRef<string | null>(null);
    const filterInput = useRef<HTMLInputElement>(null);
    const started = useRef(false);

    const visibleFiles = useMemo(() => {
        const files = comparison?.files ?? [];
        const query = filter.trim().toLowerCase();
        return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files;
    }, [comparison, filter]);

    const openRepository = async (candidate: string) => {
        if (!candidate.trim()) {
            setMessage("Enter a repository path first.");
            return;
        }
        setBusy(true);
        try {
            const nextRepo = await invoke<Repository>("open_repository", { path: candidate.trim() });
            setRepo(nextRepo);
            setPath(nextRepo.path);
            setComparison(null);
            setSelected(null);
            setDiff(null);
            setWholeFile(null);
            setViewMode("diff");
            setFilter("");
            const nextBase = nextRepo.defaultBase;
            const nextHead =
                nextRepo.currentBranch ??
                nextRepo.branches.find((branch) => branch.name !== nextBase)?.name ??
                nextBase;
            setBase(nextBase);
            setHead(nextHead);
            rememberRepository(nextRepo.path);
            setMessage(`Opened ${nextRepo.name}`);
            setModal(null);
        } catch (error) {
            setMessage(readError(error));
        } finally {
            setBusy(false);
        }
    };

    const compare = useCallback(
        async (nextBase = base, nextHead = head) => {
            if (!repo || !nextBase || !nextHead) return;
            setBusy(true);
            try {
                const nextComparison = await invoke<Comparison>("compare_branches", {
                    path: repo.path,
                    base: nextBase,
                    head: nextHead,
                });
                setComparison(nextComparison);
                setSelected(null);
                setDiff(null);
                setWholeFile(null);
                setViewMode("diff");
                setMessage(
                    `${nextComparison.files.length} changed file${nextComparison.files.length === 1 ? "" : "s"}`,
                );
            } catch (error) {
                setMessage(readError(error));
            } finally {
                setBusy(false);
            }
        },
        [base, head, repo],
    );

    const selectFile = async (file: ChangedFile) => {
        if (!repo || !comparison) return;
        selectedPath.current = file.path;
        setSelected(file);
        setDiff(null);
        setWholeFile(null);
        setViewMode("diff");
        setModal(null);
        setMessage(`Loading ${file.path}`);
        try {
            const nextDiff = await invoke<FileDiff>("get_file_diff", {
                path: repo.path,
                base: comparison.base,
                head: comparison.head,
                filePath: file.path,
            });
            if (selectedPath.current === file.path) {
                setDiff(nextDiff);
                setMessage(file.path);
            }
        } catch (error) {
            if (selectedPath.current === file.path) setMessage(readError(error));
        }
    };

    const showWholeFile = async () => {
        if (!repo || !comparison || !selected) return;
        setViewMode("file");
        if (wholeFile) return;
        const pathAtRequest = selected.path;
        setMessage(`Loading ${pathAtRequest}`);
        try {
            const revision = selected.status === "D" ? comparison.base : comparison.head;
            const contents = await invoke<FileContents>("get_file_contents", {
                path: repo.path,
                revision,
                filePath: selected.path,
            });
            if (selectedPath.current === pathAtRequest) {
                setWholeFile(contents);
                setMessage(pathAtRequest);
            }
        } catch (error) {
            if (selectedPath.current === pathAtRequest) setMessage(readError(error));
        }
    };

    const browse = async () => {
        setModal(null);
        const selectedPath = await invoke<string | null>("choose_repository");
        if (selectedPath) void openRepository(selectedPath);
    };

    const swapBranches = () => {
        if (head === LOCAL_CHECKOUT) return;
        setBase(head);
        setHead(base);
    };

    useEffect(() => {
        if (!repo || !base || !head) return;
        void compare();
    }, [compare]);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void invoke<string | null>("startup_path").then((startupPath) => {
            if (startupPath) void openRepository(startupPath);
        });
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
                event.preventDefault();
                if (comparison) setModal("files");
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
                event.preventDefault();
                setModal("repos");
            }
            if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
                event.preventDefault();
                filterInput.current?.focus();
            }
            if (event.key === "Escape") setModal(null);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [comparison]);

    return (
        <main className="app-shell">
            <header className="topbar">
                <button
                    className="brand"
                    onClick={() => setModal("repos")}
                    aria-label="Open repository command palette"
                >
                    <span>✦</span> diffie
                </button>
                <div className="path-control">
                    <input
                        value={path}
                        onChange={(event) => setPath(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && void openRepository(path)}
                        placeholder="/path/to/repository"
                        spellCheck={false}
                    />
                    <button className="browse" onClick={() => void browse()}>
                        Browse
                    </button>
                    <button className="open-path" onClick={() => void openRepository(path)}>
                        Open
                    </button>
                </div>
                <div className="branch-controls">
                    <BranchSelect
                        ariaLabel="Base branch"
                        value={base}
                        branches={repo?.branches ?? []}
                        onChange={setBase}
                    />
                    <button
                        className="swap"
                        onClick={swapBranches}
                        disabled={!repo || head === LOCAL_CHECKOUT}
                        title={
                            head === LOCAL_CHECKOUT
                                ? "Local checkout cannot be the base"
                                : "Swap base and compare branches"
                        }
                    >
                        <img src={SwapIcon} alt="" />
                    </button>
                    <BranchSelect
                        ariaLabel="Compare branch"
                        value={head}
                        branches={repo?.branches ?? []}
                        includeCheckout
                        onChange={setHead}
                    />
                </div>
            </header>
            <section className="workspace">
                <aside className="file-panel">
                    <div className="panel-title">
                        <span>changed files</span>
                        <b>{visibleFiles.length}</b>
                    </div>
                    <label className="filter">
                        <img src={SearchIcon} alt="" />
                        <input
                            ref={filterInput}
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            placeholder="filter files"
                            disabled={!repo}
                        />
                        <kbd>/</kbd>
                    </label>
                    <FileTree files={visibleFiles} selectedPath={selected?.path} onSelect={selectFile} />
                </aside>
                <section className="diff-panel">
                    {selected ? (
                        <DiffView
                            file={selected}
                            diff={diff}
                            mode={viewMode}
                            contents={wholeFile}
                            onShowDiff={() => setViewMode("diff")}
                            onShowWhole={() => void showWholeFile()}
                        />
                    ) : (
                        <EmptyReview files={comparison?.files.length} />
                    )}
                </section>
            </section>
            <footer className="statusbar">
                <span>{repo?.name ?? "no repository"}</span>
                <span className={message.includes("fatal:") ? "error" : ""}>{busy ? "Working…" : message}</span>
                <span>
                    <kbd>⌃O</kbd> files <kbd>⌘P</kbd> repositories
                </span>
            </footer>
            {modal === "files" && (
                <FilePalette files={comparison?.files ?? []} onChoose={selectFile} onClose={() => setModal(null)} />
            )}
            {modal === "repos" && (
                <RepositoryPalette
                    recents={getRecents()}
                    onChoose={openRepository}
                    onBrowse={browse}
                    onClose={() => setModal(null)}
                />
            )}
        </main>
    );
}

function BranchSelect({
    ariaLabel,
    value,
    branches,
    includeCheckout = false,
    onChange,
}: {
    ariaLabel: string;
    value: string;
    branches: BranchRef[];
    includeCheckout?: boolean;
    onChange: (value: string) => void;
}) {
    const local = branches.filter((branch) => branch.scope === "local");
    const remote = branches.filter((branch) => branch.scope === "remote");
    return (
        <label className="branch-select">
            <img className="branch-glyph" src={BranchIcon} alt="" />
            <select
                aria-label={ariaLabel}
                value={value}
                disabled={!branches.length}
                onChange={(event) => onChange(event.target.value)}
            >
                {includeCheckout && (
                    <optgroup label="Working tree">
                        <option value={LOCAL_CHECKOUT}>Local checkout</option>
                    </optgroup>
                )}
                {local.length > 0 && (
                    <optgroup label="Local branches">
                        {local.map((branch) => (
                            <option key={`local:${branch.name}`} value={branch.name}>
                                {branch.name}
                            </option>
                        ))}
                    </optgroup>
                )}
                {remote.length > 0 && (
                    <optgroup label="Remote branches">
                        {remote.map((branch) => (
                            <option key={`remote:${branch.name}`} value={branch.name}>
                                {branch.name}
                            </option>
                        ))}
                    </optgroup>
                )}
            </select>
            <img className="select-arrow" src={MoreIcon} alt="" />
        </label>
    );
}

function FileTree({
    files,
    selectedPath,
    onSelect,
}: {
    files: ChangedFile[];
    selectedPath?: string;
    onSelect: (file: ChangedFile) => void;
}) {
    if (!files.length) return <div className="empty-tree">No changed files here.</div>;
    return (
        <nav className="file-tree">
            {(["A", "M", "R", "D", "C"] as FileStatus[]).map((status) => {
                const group = files.filter((file) => file.status === status);
                if (!group.length) return null;
                return (
                    <details className={`change-group ${statusInfo[status].label}`} key={status} open>
                        <summary>
                            <span>
                                <b>{statusInfo[status].mark}</b>
                                {statusInfo[status].label}
                            </span>
                            <small>{group.length}</small>
                        </summary>
                        <TreeNodes nodes={makeTree(group)} selectedPath={selectedPath} onSelect={onSelect} />
                    </details>
                );
            })}
        </nav>
    );
}

function makeTree(files: ChangedFile[]) {
    const root: TreeNode = { name: "", path: "", children: [] };
    for (const file of files) {
        let node = root;
        const parts = file.path.split("/");
        for (const [index, part] of parts.entries()) {
            const path = node.path ? `${node.path}/${part}` : part;
            let child = node.children.find((candidate) => candidate.name === part);
            if (!child) {
                child = { name: part, path, children: [] };
                node.children.push(child);
            }
            node = child;
            if (index === parts.length - 1) node.file = file;
        }
    }
    return root.children;
}

function TreeNodes({
    nodes,
    selectedPath,
    onSelect,
}: {
    nodes: TreeNode[];
    selectedPath?: string;
    onSelect: (file: ChangedFile) => void;
}) {
    return (
        <div className="tree-nodes">
            {[...nodes]
                .sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name))
                .map((node) => {
                    const file = node.file;
                    return file ? (
                        <button
                            type="button"
                            className={`file-row ${selectedPath === file.path ? "selected" : ""}`}
                            key={node.path}
                            onClick={() => void onSelect(file)}
                            title={file.path}
                        >
                            <FileIcon path={file.path} />
                            <span>{node.name}</span>
                        </button>
                    ) : (
                        <details key={node.path} open>
                            <summary>
                                <img src={FolderIcon} alt="" />
                                {node.name}
                            </summary>
                            <TreeNodes nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} />
                        </details>
                    );
                })}
        </div>
    );
}

function FileIcon({ path }: { path: string }) {
    const filename = path.split("/").at(-1) ?? path;
    const [svg, setSvg] = useState<string>();
    useEffect(() => {
        let active = true;
        void loadFileIcons().then((getIcon) => {
            if (active) setSvg(getIcon(filename));
        });
        return () => {
            active = false;
        };
    }, [filename]);
    return svg ? (
        <span className="file-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    ) : (
        <img className="file-icon fallback" src={DescriptionIcon} alt="" />
    );
}

function languageFor(path: string) {
    const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
    if (filename === "makefile") return "makefile";
    if (filename === "dockerfile") return "dockerfile";
    const extension = filename.split(".").at(-1) ?? "";
    return languageByExtension[extension];
}

function EmptyReview({ files }: { files?: number }) {
    return (
        <div className="diff-empty">
            <div className="empty-orbit">✦</div>
            <h1>{files === undefined ? "Choose two branches" : "Select a changed file"}</h1>
            <p>
                {files === undefined
                    ? "Diffie compares branches from their merge base, just like a pull request."
                    : `${files} changed file${files === 1 ? "" : "s"} in this comparison.`}
            </p>
        </div>
    );
}

function DiffView({
    file,
    diff,
    mode,
    contents,
    onShowDiff,
    onShowWhole,
}: {
    file: ChangedFile;
    diff: FileDiff | null;
    mode: "diff" | "file";
    contents: FileContents | null;
    onShowDiff: () => void;
    onShowWhole: () => void;
}) {
    const rows = useMemo(() => (diff?.isBinary || diff?.isLarge ? [] : parseDiff(diff?.diff ?? "")), [diff]);
    const language = languageFor(file.path);
    const scroll = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scroll.current,
        estimateSize: (index) => (rows[index]?.kind === "hunk" ? 29 : 22),
        overscan: 24,
    });
    useEffect(() => {
        scroll.current?.scrollTo({ top: 0 });
        virtualizer.scrollToOffset(0);
    }, [file.path]);
    const singleSide = file.status === "A" ? "new" : file.status === "D" ? "old" : undefined;
    return (
        <div className="diff-view">
            <header className="diff-header">
                <div>
                    <strong>{file.path}</strong>
                    <span>
                        {file.previousPath ? `${file.previousPath} → ${file.path}` : statusInfo[file.status].label}
                    </span>
                </div>
                <div className="view-toggle">
                    <button className={mode === "diff" ? "active" : ""} onClick={onShowDiff}>
                        diff
                    </button>
                    <button className={mode === "file" ? "active" : ""} onClick={onShowWhole}>
                        whole file
                    </button>
                </div>
            </header>
            {mode === "file" ? (
                <WholeFile contents={contents} status={file.status} language={language} />
            ) : !diff ? (
                <div className="loading">Loading diff…</div>
            ) : diff.isBinary ? (
                <div className="loading">Binary file changed. Diffie does not render binary patches.</div>
            ) : diff.isLarge ? (
                <div className="loading">
                    This diff has {diff.lineCount.toLocaleString()} lines. It is too large to render safely.
                </div>
            ) : (
                <div className="diff-scroll" ref={scroll}>
                    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                        {virtualizer.getVirtualItems().map((item) => (
                            <DiffRowView
                                key={item.key}
                                row={rows[item.index]}
                                language={language}
                                singleSide={singleSide}
                                style={{
                                    position: "absolute",
                                    top: 0,
                                    left: 0,
                                    width: "100%",
                                    transform: `translateY(${item.start}px)`,
                                }}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function DiffRowView({
    row,
    style,
    singleSide,
    language,
}: {
    row: DiffRow;
    style: React.CSSProperties;
    singleSide?: "old" | "new";
    language?: string;
}) {
    if (row.kind === "hunk")
        return (
            <div className={`hunk ${singleSide ? "single" : ""}`} style={style}>
                {row.label}
            </div>
        );
    if (singleSide)
        return (
            <div className={`single-diff-row ${row.change}`} style={style}>
                <CodeCell line={singleSide === "old" ? row.old : row.next} side={singleSide} language={language} />
            </div>
        );
    return (
        <div className={`diff-row ${row.change}`} style={style}>
            <CodeCell line={row.old} side="old" language={language} />
            <CodeCell line={row.next} side="new" language={language} />
        </div>
    );
}
function CodeCell({ line, side, language }: { line?: DiffLine; side: "old" | "new"; language?: string }) {
    return (
        <div className={`code-cell ${side} ${line?.kind ?? "blank"}`}>
            <span>{line?.number ?? ""}</span>
            <HighlightedCode text={line?.text ?? ""} language={language} />
        </div>
    );
}

function WholeFile({
    contents,
    status,
    language,
}: {
    contents: FileContents | null;
    status: FileStatus;
    language?: string;
}) {
    const lines = useMemo(() => contents?.content.split("\n") ?? [], [contents]);
    const scroll = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: lines.length,
        getScrollElement: () => scroll.current,
        estimateSize: () => 22,
        overscan: 24,
    });
    if (!contents) return <div className="loading">Loading whole file…</div>;
    if (contents.isBinary)
        return <div className="loading">Binary file changed. Diffie does not render binary files.</div>;
    return (
        <div className={`whole-file ${status === "D" ? "deleted" : ""}`} ref={scroll}>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => (
                    <div
                        className="whole-line"
                        key={item.key}
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${item.start}px)`,
                        }}
                    >
                        <span>{item.index + 1}</span>
                        <HighlightedCode text={lines[item.index]} language={language} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function HighlightedCode({ text, language }: { text: string; language?: string }) {
    const [html, setHtml] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        setHtml(null);
        if (!language)
            return () => {
                active = false;
            };
        void loadHighlighter().then((highlighter) => {
            if (active && highlighter.getLanguage(language))
                setHtml(highlighter.highlight(text, { language, ignoreIllegals: true }).value);
        });
        return () => {
            active = false;
        };
    }, [text, language]);
    return html === null ? <code>{text}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />;
}

function FilePalette({
    files,
    onChoose,
    onClose,
}: {
    files: ChangedFile[];
    onChoose: (file: ChangedFile) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => input.current?.focus(), []);
    const matches = files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
    return (
        <ModalFrame title="Open changed file" shortcut="⌃O" onClose={onClose}>
            <label className="palette-search">
                <img src={SearchIcon} alt="" />
                <input
                    ref={input}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search changed files"
                />
            </label>
            <div className="palette-list">
                {matches.map((file) => (
                    <button key={file.path} onClick={() => void onChoose(file)}>
                        <FileIcon path={file.path} />
                        <span>{file.path}</span>
                        <em>{statusInfo[file.status].label}</em>
                    </button>
                ))}
            </div>
        </ModalFrame>
    );
}

function RepositoryPalette({
    recents,
    onChoose,
    onBrowse,
    onClose,
}: {
    recents: string[];
    onChoose: (path: string) => void;
    onBrowse: () => void;
    onClose: () => void;
}) {
    const [value, setValue] = useState("");
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => input.current?.focus(), []);
    return (
        <ModalFrame title="Open repository" shortcut="⌘P" onClose={onClose}>
            <label className="palette-search">
                <img src={SearchIcon} alt="" />
                <input
                    ref={input}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void onChoose(value)}
                    placeholder="Enter repository path"
                />
            </label>
            <div className="palette-list">
                <button className="browse-row" onClick={() => void onBrowse()}>
                    <img src={FolderOpenIcon} alt="" />
                    <span>Browse for a repository</span>
                </button>
                {recents.length > 0 && <div className="recent-label">recent repositories</div>}
                {recents.map((recent) => (
                    <button key={recent} onClick={() => void onChoose(recent)}>
                        <img src={FolderIcon} alt="" />
                        <span>{recent}</span>
                    </button>
                ))}
            </div>
        </ModalFrame>
    );
}

function ModalFrame({
    title,
    shortcut,
    children,
    onClose,
}: {
    title: string;
    shortcut: string;
    children: React.ReactNode;
    onClose: () => void;
}) {
    return (
        <div
            className="modal-backdrop"
            role="button"
            tabIndex={-1}
            aria-label="Close command palette"
            onMouseDown={onClose}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onClose();
            }}
        >
            <section
                className="command-palette"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header>
                    <span>{title}</span>
                    <div>
                        <kbd>{shortcut}</kbd>
                        <button onClick={onClose}>
                            <img src={CloseIcon} alt="Close" />
                        </button>
                    </div>
                </header>
                {children}
            </section>
        </div>
    );
}

function parseDiff(diff: string): DiffRow[] {
    const rows: DiffRow[] = [];
    let oldNumber = 0;
    let newNumber = 0;
    let removed: DiffLine[] = [];
    let added: DiffLine[] = [];
    const flush = () => {
        const count = Math.max(removed.length, added.length);
        for (let index = 0; index < count; index += 1)
            rows.push({
                kind: "line",
                old: removed[index],
                next: added[index],
                change: removed[index] && added[index] ? "changed" : removed[index] ? "removed" : "added",
            });
        removed = [];
        added = [];
    };
    for (const line of diff.split("\n")) {
        if (line.startsWith("@@")) {
            flush();
            const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
                oldNumber = Number(match[1]);
                newNumber = Number(match[2]);
            }
            rows.push({ kind: "hunk", label: line });
        } else if (line.startsWith("-") && !line.startsWith("---"))
            removed.push({ number: oldNumber++, text: line.slice(1), kind: "removed" });
        else if (line.startsWith("+") && !line.startsWith("+++"))
            added.push({ number: newNumber++, text: line.slice(1), kind: "added" });
        else if (line.startsWith(" ")) {
            flush();
            rows.push({
                kind: "line",
                old: { number: oldNumber++, text: line.slice(1), kind: "context" },
                next: { number: newNumber++, text: line.slice(1), kind: "context" },
                change: "context",
            });
        }
    }
    flush();
    return rows;
}

function readError(error: unknown) {
    return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}
