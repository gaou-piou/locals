import { mount } from "svelte";
import "../app.css";
import App from "./App.svelte";

const target = document.getElementById("app")!;

/** A blank popup is undiagnosable, so any startup failure is written into the popup itself. */
const showError = (err: unknown) => {
  const p = Object.assign(document.createElement("p"), {
    className: "p-4 text-sm text-red-600",
    textContent: `cdn-mirror popup failed: ${err instanceof Error ? err.message : String(err)}`,
  });
  target.replaceChildren(p);
};
window.addEventListener("error", (e) => showError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showError(e.reason));

try {
  mount(App, { target });
} catch (err) {
  showError(err);
}
