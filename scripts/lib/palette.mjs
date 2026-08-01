/** palette.mjs — stable project color assignment, shared by both data sources. */
export const PALETTE = ["#c1852c", "#2f8f6e", "#2f6f8f", "#9a5bc4", "#c9524f", "#4a9d7f", "#d98b4a", "#7c6ff0"];
export const DEFAULT_COLOR = "#82869a";
export function colorFor(idx, isDefault) {
  return isDefault ? DEFAULT_COLOR : PALETTE[idx % PALETTE.length];
}
