"use client";

import { useEffect, useId, useState } from "react";
import { loadSpaceChoice, saveSpaceChoice, SPACE_NAME_MAX, SPACE_TYPES, type SpaceChoice } from "@/lib/client/spaceType";

/**
 * "What kind of space?" on the video card (richer findings, item 3). The pick and the optional name are saved
 * on this device as they change; the run reads them when it starts (selectRunner → savedSpaceRequestFields),
 * so the plan gets the checks for that kind of space and a real title instead of "Walkthrough".
 */
export function SpacePicker() {
  const id = useId();
  const [choice, setChoice] = useState<SpaceChoice>({ typeId: "", name: "" });
  // Read after mount so the server render and the first client render match.
  useEffect(() => setChoice(loadSpaceChoice()), []);
  const update = (next: SpaceChoice) => {
    setChoice(next);
    saveSpaceChoice(next);
  };
  return (
    <fieldset className="mb-3" data-testid="space-picker">
      <legend className="text-sm font-semibold">
        What kind of space? <span className="font-normal text-ink/65">(optional)</span>
      </legend>
      <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink/70">
        Helps SightWork check what matters in this kind of space. Saved on this device.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={`${id}-type`} className="block text-xs font-medium text-ink/80">
            Type
          </label>
          <select
            id={`${id}-type`}
            aria-describedby={`${id}-hint`}
            value={choice.typeId}
            onChange={(e) => update({ ...choice, typeId: e.target.value })}
            className="mt-1 min-h-11 w-full rounded-lg border border-ink/20 bg-white px-2 text-base"
          >
            <option value="">Choose…</option>
            {SPACE_TYPES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-name`} className="block text-xs font-medium text-ink/80">
            Name
          </label>
          <input
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            maxLength={SPACE_NAME_MAX}
            placeholder="e.g. Main sanctuary"
            value={choice.name}
            onChange={(e) => update({ ...choice, name: e.target.value })}
            className="mt-1 min-h-11 w-full rounded-lg border border-ink/20 bg-white px-3 text-base placeholder:text-ink/45"
          />
        </div>
      </div>
    </fieldset>
  );
}
