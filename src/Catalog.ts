import { coreCases } from "./CoreCases.js";
import { serviceCases } from "./ServiceCases.js";
import { nodeCases } from "./NodeCases.js";
import { extensionCases } from "./ExtensionCases.js";
export const cases = [
  ...coreCases,
  ...serviceCases,
  ...nodeCases,
  ...extensionCases,
];
export type Suite = "all" | "core" | "bindings" | "node" | "extensions";
export const suites = {
  all: cases,
  core: coreCases,
  bindings: serviceCases,
  node: nodeCases,
  extensions: extensionCases,
};
