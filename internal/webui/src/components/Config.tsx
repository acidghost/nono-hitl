import "./Config.css";
import { useEffect } from "preact/hooks";
import { displayArg, prefixTokens } from "../format";
import {
  addClassifier,
  type DraftClassifier,
  type DraftField,
  editClassifier,
  loadConfig,
  removeClassifier,
  saveConfig,
  state,
} from "../store";

// The config file as one form: settings first, then the classifiers. Edits stay in the browser
// until Save sends them. Shortcuts skip inputs, so typing an ask can't switch views.
export function Config() {
  useEffect(() => void loadConfig(), []);
  const { draft, ollamaURL, changed, saving, error } = state.config;
  if (!draft) {
    return (
      <p class="list-empty text-muted" id="config-loading">
        {error || "Loading the config…"}
      </p>
    );
  }
  return (
    <form
      id="config"
      onSubmit={(event) => {
        event.preventDefault();
        void saveConfig();
      }}
    >
      <dl class="config-file">
        <dt class="text-muted">Ollama URL</dt>
        <dd class="break-anywhere">
          <code id="ollama-url">{ollamaURL}</code>{" "}
          <span class="text-small text-muted">Edit the config file to change it.</span>
        </dd>
      </dl>
      <h2 class="config-heading">Classifiers</h2>
      <p class="config-intro text-muted">
        A request whose arguments start with a prefix gets the model's answer to the ask on its
        card. The longest prefix wins.
      </p>
      {draft.map((entry, index) => (
        <ClassifierFields key={entry.key} entry={entry} number={index + 1} />
      ))}
      <button class="add-classifier" type="button" onClick={addClassifier}>
        Add classifier
      </button>
      <div class="config-bar row">
        <p class="config-status break-anywhere" id="config-status" role="status">
          {error ? (
            <strong class="config-error">{error}</strong>
          ) : changed ? (
            <strong>Unsaved changes</strong>
          ) : (
            <span class="text-muted">No unsaved changes</span>
          )}
        </p>
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
