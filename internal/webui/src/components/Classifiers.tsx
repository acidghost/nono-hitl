import "./Classifiers.css";
import { useEffect } from "preact/hooks";
import { displayArg, prefixTokens } from "../format";
import {
  addClassifier,
  type DraftClassifier,
  type DraftField,
  editClassifier,
  loadClassifiers,
  removeClassifier,
  saveClassifiers,
  state,
} from "../store";

// The config file's classifiers as one form. Edits stay in the browser until Save sends the
// whole list. Shortcuts skip inputs, so typing an ask can't switch views.
export function Classifiers() {
  useEffect(() => void loadClassifiers(), []);
  const { draft, ollamaURL, changed, saving, error } = state.classifiers;
  if (!draft) {
    return (
      <p class="list-empty text-muted" id="classifiers-loading">
        {error || "Loading classifiers…"}
      </p>
    );
  }
  return (
    <form
      id="classifiers"
      onSubmit={(event) => {
        event.preventDefault();
        void saveClassifiers();
      }}
    >
      <p class="classifiers-intro text-muted">
        A request whose arguments start with a prefix gets the model's answer to the ask on its
        card. The longest prefix wins.
      </p>
      {draft.map((entry, index) => (
        <ClassifierFields key={entry.key} entry={entry} number={index + 1} />
      ))}
      <button class="add-classifier" type="button" onClick={addClassifier}>
        Add classifier
      </button>
      <div class="classifiers-bar row">
        <div class="classifiers-note break-anywhere">
          <p id="classifiers-status" role="status">
            {error ? (
              <strong class="classifiers-error">{error}</strong>
            ) : (
              changed && <strong>Unsaved changes</strong>
            )}
          </p>
          <p class="text-small text-muted">
            Calls go to <code id="ollama-url">{ollamaURL}</code>, set in the config file.
          </p>
        </div>
        <button class="save-button" type="submit" disabled={saving || !changed}>
          Save
        </button>
      </div>
    </form>
  );
}

// The header previews the prefix as the argv chips of a request card it would match.
function ClassifierFields({ entry, number }: { entry: DraftClassifier; number: number }) {
  const id = (field: DraftField) => `classifier-${entry.key}-${field}`;
  const edit = (field: DraftField) => (event: { currentTarget: { value: string } }) =>
    editClassifier(entry.key, field, event.currentTarget.value);
  const tokens = prefixTokens(entry.prefix);
  const maxRisk = Math.min(1, Math.max(0, Number(entry.maxRisk) || 0));
  return (
    <fieldset class="classifier">
      <legend class="sr-only">Classifier {number}</legend>
      <div class="classifier-head row">
        <span class="classifier-chips" aria-hidden="true">
          {tokens.length === 0 && <span class="text-muted">New classifier</span>}
          {tokens.map((token, index) => (
            <code key={index} class={index === 0 ? "chip chip-command" : "chip"}>
              {displayArg(token)}
            </code>
          ))}
          {tokens.length > 0 && <code class="chip chip-rest">…</code>}
        </span>
        <span class="text-small text-muted" aria-hidden="true">
          Classifier {number}
        </span>
        <button class="quiet text-small" type="button" onClick={() => removeClassifier(entry.key)}>
          Remove
        </button>
      </div>
      <div class="classifier-body">
        <label class="text-muted" for={id("prefix")}>
          Prefix
        </label>
        <input
          class="classifier-prefix"
          id={id("prefix")}
          value={entry.prefix}
          required
          autocomplete="off"
          spellcheck={false}
          placeholder="docker run"
          onInput={edit("prefix")}
        />
        <label class="text-muted" for={id("ask")}>
          Ask
        </label>
        <div class="classifier-ask">
          <textarea
            id={id("ask")}
            rows={2}
            value={entry.ask}
            required
            aria-describedby={`${id("ask")}-hint`}
            placeholder="Is this docker command dangerous or risky?"
            onInput={edit("ask")}
          />
          <p class="text-small text-muted" id={`${id("ask")}-hint`}>
            Phrase it so yes means risky.
          </p>
        </div>
        <label class="text-muted" for={id("model")}>
          Model
        </label>
        <div class="row">
          <input
            class="classifier-model"
            id={id("model")}
            value={entry.model}
            required
            autocomplete="off"
            spellcheck={false}
            onInput={edit("model")}
          />
          <label class="row gap-small text-muted" for={id("mode")}>
            Mode
            <select id={id("mode")} value={entry.mode} onChange={edit("mode")}>
              <option value="advise">advise</option>
            </select>
          </label>
        </div>
        <label class="text-muted" for={id("maxRisk")}>
          Max risk
        </label>
        <div class="risk-row row">
          <span class="risk-value" aria-hidden="true">
            {maxRisk.toFixed(3)}
          </span>
          <span class="risk-safe text-small" aria-hidden="true">
            Looks safe
          </span>
          <input
            class="risk-slider"
            id={id("maxRisk")}
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={entry.maxRisk}
            aria-valuetext={`Looks safe up to ${maxRisk.toFixed(3)}`}
            style={{ "--max-risk": String(maxRisk) }}
            onInput={edit("maxRisk")}
          />
          <span class="risk-risky text-small" aria-hidden="true">
            Looks risky
          </span>
        </div>
      </div>
    </fieldset>
  );
}
