import * as vscode from "vscode";
import { FlatEarth } from "./flatEarth";

export function activate(context: vscode.ExtensionContext) {
  const flatEarth = new FlatEarth(context);
}
