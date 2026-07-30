/**
 * The renderer's entry point — spec §5.1.
 *
 * Nothing but mounting. The renderer is "pure presentation and input" and holds
 * no pipeline logic, so this file has nothing to configure: every capability it
 * has arrives through `window.api`, and every type it speaks comes from
 * `shared/` as a type-only import that erases at build time.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing #root — the renderer has nothing to mount into");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
