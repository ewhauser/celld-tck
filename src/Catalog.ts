import { coreCases } from "./CoreCases.js";
import { serviceCases } from "./ServiceCases.js";
import { nodeCases } from "./NodeCases.js";
import { extensionCases } from "./ExtensionCases.js";
import { reproCases } from "./ReproCases.js";
const conformanceCases = [
  ...coreCases,
  ...serviceCases,
  ...nodeCases,
  ...extensionCases,
];
export const cases = [...conformanceCases, ...reproCases];
export type Suite =
  | "all"
  | "core"
  | "bindings"
  | "node"
  | "extensions"
  | "repros";
export const suites = {
  all: conformanceCases,
  repros: reproCases,
  core: coreCases,
  bindings: serviceCases,
  node: nodeCases,
  extensions: extensionCases,
};
