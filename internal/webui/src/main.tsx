import "./css/layers.css";
import "./css/tokens.css";
import "./css/base.css";
import "./css/utilities.css";
import { render } from "preact";
import { App } from "./components/App";
import { onKeyDown } from "./keyboard";
import {
  arm,
  notifyAll,
  refresh,
  resync,
  setView,
  start,
  state,
  subscribe,
  viewFromHash,
} from "./store";

const root = document.getElementById("app") as HTMLElement;
let cardFocus = state.cardFocus;
let rowFocus = state.rowFocus;

// Renders synchronously on every store change, then carries out focus requests. A request is
// used up even when its target isn't rendered, so it can't fire on a later render.
function renderApp() {
  const active = document.activeElement;
  render(<App />, root);
  const review = document.getElementById("review");
  if (state.cardFocus !== cardFocus) {
    cardFocus = state.cardFocus;
    review?.focus({ preventScroll: true });
  } else if (active instanceof HTMLElement && !active.isConnected) {
    // The focused tab, row or button went away; the card is the next useful place.
    review?.focus({ preventScroll: true });
  }
  if (state.rowFocus !== rowFocus) {
    rowFocus = state.rowFocus;
    const row = root.querySelector<HTMLElement>('.list-row[aria-current="true"]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }
}

subscribe(renderApp);
document.addEventListener("keydown", onKeyDown);
window.addEventListener("focus", arm);
window.addEventListener("hashchange", () => {
  const name = viewFromHash();
  if (name) setView(name);
});
window.addEventListener("online", resync);
window.addEventListener("blur", notifyAll);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resync();
});
start();
setInterval(refresh, 1000);
