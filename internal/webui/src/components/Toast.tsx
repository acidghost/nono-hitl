import "./Toast.css";
import { state } from "../store";

// Visible confirmation. Screen readers get the same text from the live region, so the toast
// itself stays out of the accessibility tree.
export function Toast() {
  return (
    <div
      class="toast"
      id="toast"
      aria-hidden="true"
      data-state={state.toast.outcome}
      hidden={!state.toast.shown}
    >
      {state.toast.message}
    </div>
  );
}
