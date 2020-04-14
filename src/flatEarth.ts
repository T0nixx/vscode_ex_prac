import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as mkdirp from "mkdirp";
import * as rimraf from "rimraf";

namespace _ {
    function handleResult<T>(
        resolve: (result: T) => void,
        reject: (error: Error) => void,
        error: Error | null | undefined,
        result: T
    ): void {
        if (error) {
            reject(massageError(error));
        } else {
            resolve(result);
        }
    }

    function massageError(error: Error & { code?: string }): Error {
        if (error.code === "ENOENT") {
            return vscode.FileSystemError.FileNotFound();
        }

        if (error.code === "EISDIR") {
            return vscode.FileSystemError.FileIsADirectory();
        }

        if (error.code === "EEXIST") {
            return vscode.FileSystemError.FileExists();
        }

        if (error.code === "EPERM" || error.code === "EACCESS") {
            return vscode.FileSystemError.NoPermissions();
        }

        return error;
    }

    export function checkCancellation(token: vscode.CancellationToken): void {
        if (token.isCancellationRequested) {
            throw new Error("Operation cancelled");
        }
    }

    export function normalizeNFC(items: string): string;
    export function normalizeNFC(items: string[]): string[];
    export function normalizeNFC(items: string | string[]): string | string[] {
        if (process.platform !== "darwin") {
            return items;
        }

        if (Array.isArray(items)) {
            return items.map((item) => item.normalize("NFC"));
        }

        return items.normalize("NFC");
    }

    export function readdir(path: string): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            fs.readdir(path, (error, children) =>
                handleResult(resolve, reject, error, normalizeNFC(children))
            );
        });
    }

    export function stat(path: string): Promise<fs.Stats> {
        return new Promise<fs.Stats>((resolve, reject) => {
            fs.stat(path, (error, stat) =>
                handleResult(resolve, reject, error, stat)
            );
        });
    }

    export function readfile(path: string): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            fs.readFile(path, (error, buffer) =>
                handleResult(resolve, reject, error, buffer)
            );
        });
    }

    export function writefile(path: string, content: Buffer): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            fs.writeFile(path, content, (error) =>
                handleResult(resolve, reject, error, void 0)
            );
        });
    }

    export function exists(path: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            fs.exists(path, (exists) =>
                handleResult(resolve, reject, null, exists)
            );
        });
    }

    export function rmrf(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            rimraf(path, (error) =>
                handleResult(resolve, reject, error, void 0)
            );
        });
    }

    export function mkdir(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            mkdirp(path, (error) =>
                handleResult(resolve, reject, error, void 0)
            );
        });
    }

    export function rename(oldPath: string, newPath: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            fs.rename(oldPath, newPath, (error) =>
                handleResult(resolve, reject, error, void 0)
            );
        });
    }

    export function unlink(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            fs.unlink(path, (error) =>
                handleResult(resolve, reject, error, void 0)
            );
        });
    }
}

export class FileStat implements vscode.FileStat {
    constructor(private fsStat: fs.Stats) {}

    get type(): vscode.FileType {
        return this.fsStat.isFile()
            ? vscode.FileType.File
            : this.fsStat.isDirectory()
            ? vscode.FileType.Directory
            : this.fsStat.isSymbolicLink()
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.Unknown;
    }

    get isFile(): boolean | undefined {
        return this.fsStat.isFile();
    }

    get isDirectory(): boolean | undefined {
        return this.fsStat.isDirectory();
    }

    get isSymbolicLink(): boolean | undefined {
        return this.fsStat.isSymbolicLink();
    }

    get size(): number {
        return this.fsStat.size;
    }

    get ctime(): number {
        return this.fsStat.ctime.getTime();
    }

    get mtime(): number {
        return this.fsStat.mtime.getTime();
    }
}

interface Entry {
    uri: vscode.Uri;
    type: vscode.FileType;
    tag?: string;
}

export class FlatProvider implements vscode.TreeDataProvider<any> {
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter<
            vscode.FileChangeEvent[]
        >();
    }

    get onDidChangeFile(): vscode.Event<vscode.FileChangeEvent[]> {
        return this._onDidChangeFile.event;
    }

    watch(
        uri: vscode.Uri,
        options: { recursive: boolean; excludes: string[] }
    ): vscode.Disposable {
        const watcher = fs.watch(
            uri.fsPath,
            { recursive: options.recursive },
            async (event: string, filename: string | Buffer) => {
                const filepath = path.join(
                    uri.fsPath,
                    _.normalizeNFC(filename.toString())
                );

                // TODO support excludes (using minimatch library?)

                this._onDidChangeFile.fire([
                    {
                        type:
                            event === "change"
                                ? vscode.FileChangeType.Changed
                                : (await _.exists(filepath))
                                ? vscode.FileChangeType.Created
                                : vscode.FileChangeType.Deleted,
                        uri: uri.with({ path: filepath }),
                    } as vscode.FileChangeEvent,
                ]);
            }
        );

        return { dispose: () => watcher.close() };
    }

    stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
        return this._stat(uri.fsPath);
    }

    async _stat(path: string): Promise<vscode.FileStat> {
        return new FileStat(await _.stat(path));
    }

    readDirectory(
        uri: vscode.Uri
    ): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        return this._readDirectory(uri);
    }

    async _readDirectory(
        uri: vscode.Uri
    ): Promise<[string, vscode.FileType][]> {
        const children = await _.readdir(uri.fsPath);

        const result: [string, vscode.FileType][] = await Promise.all(
            children.map(
                async (child: string): Promise<[string, vscode.FileType]> => {
                    const stat = await this._stat(path.join(uri.fsPath, child));
                    return [child, stat.type];
                }
            )
        );

        return result;
    }

    // at first be called without element
    async getChildren(element?: Entry): Promise<Entry[]> {
        if (element) {
            console.log(element);
            const children = await this.readDirectory(element.uri);

            return children.reduce<Entry[]>((arr, [name, type]) => {
                if (name.includes(element.tag)) {
                    return [
                        {
                            uri: vscode.Uri.file(
                                path.join(element.uri.fsPath, name)
                            ),
                            type,
                        },
                        ...arr,
                    ];
                }

                return arr;
            }, []);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders.filter(
            (folder) => folder.uri.scheme === "file"
        )[0];

        if (workspaceFolder) {
            const children = await this.readDirectory(workspaceFolder.uri);
            // children.sort((a, b) => {
            //     if (a[1] === b[1]) {
            //         return a[0].localeCompare(b[0]);
            //     }
            //     return a[1] === vscode.FileType.Directory ? -1 : 1;
            // });

            const tags = children.reduce<string[]>((arr, [name]) => {
                const splitted = name.split(".");
                const fileTags = splitted.slice(1, -1);

                const uniqueTag = new Set([...arr, ...fileTags]);

                return [...uniqueTag];
            }, []);

            return tags.map((tag) => ({
                uri: vscode.Uri.file(workspaceFolder.uri.fsPath),
                type: vscode.FileType.Directory,
                tag,
            }));
        }
        return [];
    }

    // called for each top level tree items
    getTreeItem(element: Entry): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.uri,
            element.type === vscode.FileType.Directory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        const paths = element.uri.path.split("/");
        const leaf = paths[paths.length - 1];
        treeItem.label = element.tag ? element.tag : leaf.split(".")[0];

        if (element.type === vscode.FileType.File) {
            treeItem.command = {
                command: "flatEarth.openFile",
                title: "Open File",
                arguments: [element.uri],
            };
            treeItem.contextValue = "file";
        }
        return treeItem;
    }
}

export class FlatEarth {
    private flatExplorer: vscode.TreeView<Entry>;

    constructor(context: vscode.ExtensionContext) {
        const flatProvider = new FlatProvider();
        const workspaceFolder = vscode.workspace.workspaceFolders.filter(
            (folder) => folder.uri.scheme === "file"
        )[0];

        console.log(JSON.stringify(workspaceFolder));
        const listner = flatProvider.watch(workspaceFolder.uri, {
            recursive: true,
            excludes: [],
        });
        this.flatExplorer = vscode.window.createTreeView("flatEarth", {
            treeDataProvider: flatProvider,
        });
        vscode.commands.registerCommand("flatEarth.openFile", (resource) =>
            this.openResource(resource)
        );
    }

    private openResource(resource: vscode.Uri): void {
        vscode.window.showTextDocument(resource);
    }
}
