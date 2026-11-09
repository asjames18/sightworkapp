/**
 * SightWork pipeline prompts: prompt 03 (reason) and prompt 05 (cost).
 *
 * Templates and schemas copied verbatim from the prompt specs on
 * 2026-10-26 (prompt 03 reason, prompt 05 costRange;
 * prompt 03 re-synced 2026-10-27 for rule 7: no total/subtotal inventory rows; 2026-10-29 proposal A (one-take zone counting) applied to the template here — the prompt 03 spec still needs the matching edit so a later re-copy does not clobber it. 2026-10-30 richer-findings patch (zone-by-zone sweep, watch bucket, tier, evidence) applied to the template and REASON_SCHEMA here from the 2026-10-30 4:30 PM proposal; the prompt 03 spec still needs the matching edit. 2026-10-30 plumbing checklist line added (9:05 PM review): general Plumbing [plumbing] line plus kitchen space line. 2026-10-29 Finding A: frame list carries zoneId and the SEGMENTATION header now says per-zone sums, not a single-frame max — the prompt 03 spec still needs the matching edit.
 * the specs set the prompt wording). When a prompt file changes, re-copy
 * the template and schema here and bump the date above; the route must
 * never run a stale prompt against a new schema, or vice versa.
 *
 * Why this module exists: runReason and estimateCost take a static
 * deps.prompt, but prompts 03 and 05 carry per-request variables
 * (frame list, segmentation JSON, transcript, materials, steps). The
 * builders below fill those variables from the step input, so the
 * /api/plan route can hand each step a finished prompt. The builders
 * are pure: no API calls, no keys, no provider text.
 *
 * The builders validate their own inputs and refuse to emit a prompt
 * with an unfilled placeholder. runPlan calls a builder before the
 * step's own validator runs, so without this a bad step input failed
 * here with a bare TypeError (or, worse, produced a prompt carrying
 * "undefined"/"NaN" that only failed later, after the step validator).
 * A builder failure is still pre-call: no paid Spark call is spent.
 */

import type { CostInput } from "./cost";
import type { ReasonInput } from "./reason";

/** Prompt 03 template; placeholders are filled by buildReasonPrompt. */
export const REASON_PROMPT_TEMPLATE: string = "You are SightWork. Someone filmed a walkthrough of a {{space_type}} called \"{{space_name}}\" ({{duration_sec}} s) while saying out loud what needs work. You get {{frame_count}} still frames from that video, an object count from a segmentation model, and the narration transcript. Produce a work plan as JSON matching the provided schema exactly. Output JSON only. The frames come from one continuous take: the camera may revisit an area from another angle, and a revisited area is the same area, not a new one.\n\nFRAMES (images are attached in this order; frameIndex is the position, starting at 0):\n{{frame_list}}\n\nSEGMENTATION (SAM 3.1; counts are summed across zones, each zone counted once from its best frame, floored at the max seen in any single frame; flaggedFrames had a possible hazard):\n{{segmentation_json}}\n\nTRANSCRIPT (each line starts with [seconds] when the speaker started that sentence):\n{{transcript}}\n\nDo this in order:\n\n1. LOOK. Sweep the space zone by zone, then frame by frame inside each zone. In every frame, check each line of this checklist, and use the key in brackets for \"checklistKey\" (and for \"hazard\" when it is one of the original 8 keys):\n   - Life safety [egress] exits and egress paths, [exit_sign] exit signs missing or unlit, [fire_extinguisher] extinguisher missing, unmounted or blocked, [fire_alarm] alarm pull or strobe blocked or missing, [blocked_aisle] aisles or doors blocked, [stage_edge] stage edge or drop-off with no marking, [steps] steps with no nosing, contrast or rail.\n   - Electrical [exposed_wiring] exposed wiring or missing cover plates, [power_strip] overloaded or daisy-chained strips, [cord_under_rug] cords under rugs or through doorways.\n   - AV [trip_cable] loose or crossed cables in walkways, [av_unsecured] unsecured speakers, stands or stacked gear, [mic_stand] mic stands or cases in a walkway.\n   - Lighting [lighting] dead or flickering lamps, missing lenses, mismatched colour.\n   - Seating [damaged_seating] damaged, stained or wobbly seats, misaligned rows.\n   - Flooring [flooring] worn or stained carpet, lifted seams, tape residue, uneven transitions.\n   - Walls, paint, ceiling [walls] scuffs, chips, cracks; [water_stain] water stains or sagging; [ceiling] missing or broken tiles.\n   - Doors and windows [doors_windows] hardware, closers, blinds.\n   - Clutter and storage [clutter] boxes, tangled cords, loose items on the stage or in walkways.\n   - Signage and wayfinding [signage]. Cleanliness [cleanliness].\n   - Accessibility [ada_path] no ramp or rail, no accessible seating space, path too narrow.\n   - HVAC [hvac] blocked, dirty or damaged vents and returns.\n   - Plumbing [plumbing] leaks, corroded valves and drain lines, water heater.\n   For a {{space_type}}, also check: {{space_checklist}}\n   Look hardest at flaggedFrames and at any SAM box listed for a frame.\n   Give each issue \"area\": where in the space it is, in a few words (e.g. \"stage, front left\").\n\n2. LISTEN. List every need the speaker states in the transcript. Write transcriptSummary: one or two plain sentences on what the speaker asked for (null if \"(no narration)\").\n\n3. COMPARE (said vs. seen). For each issue, set \"status\":\n   - \"mentioned\": the speaker said it and a frame shows it. Set \"mention\" to {\"quote\": their exact words, \"saidAtSec\": the [seconds] of that line}. \"unmentioned\": false.\n   - \"unmentioned\": the speaker never said it and it is clearly visible in a specific frame. \"mention\": null. \"unmentioned\": true. Never mark something unmentioned from a guess.\n   - \"mentioned_not_seen\": the speaker said it but no frame clearly shows it. Fill \"mention\", set \"unmentioned\": false, use the frame closest in time to when it was said, and start \"detail\" with: Mentioned in narration, not clearly visible in the frames.\n   - If the transcript is \"(no narration)\", every issue is \"unmentioned\".\n   \"unmentioned\" must be true exactly when status is \"unmentioned\".\n   Also write saidVsSeen: one row per issue, in rank order, with \"status\", \"said\" ({\"quote\",\"atSec\"} or null for unmentioned), \"seen\" ({\"summary\": what the frame shows, \"frameIndex\"} or null for mentioned_not_seen) and \"issueRank\".\n\n4. FILTER. Give each issue a \"confidence\" from 0 to 1. Aim to report every real, visible problem. Keep issues at 0.5 or above (an unmentioned one needs at least 0.6) in \"issues\". Put issues from 0.35 up to that bar in \"watch\" instead, each with its primary frame; never drop them silently. If \"issues\" has fewer than 3 entries, set \"coverageNote\" to one plain sentence saying why (e.g. \"Only the stage was filmed; the seating and back wall were not in the frames.\"), else null. Do not invent problems to reach 3.\n\n5. RANK. Order issues by: life-safety and code first (egress, exit signs, trip hazards, exposed wiring, extinguishers), then active damage that gets worse (leaks, water stains), then function (broken seating, dead lights, missing items), then cosmetic. Within a tier, things affecting more people or used every service rank higher. rank starts at 1 and has no gaps. severity: \"high\" for safety/code or active damage, \"medium\" for function, \"low\" for cosmetic. category: \"safety\", \"damage\", \"function\" or \"cosmetic\" to match the tier. Set \"hazard\" only when the issue matches a checklist item. Also set \"tier\": \"urgent\" for life safety now, \"soon\" for damage that grows or broken function, \"later\" for cosmetic.\n\n6. EVIDENCE. Every issue has one primary frameIndex: the frame that best shows it (0 to {{frame_count}} minus 1), and frameTimeSec equal to that frame's t. \"proofFrames\" lists every frame that shows it, starting with the primary one, each with frameIndex, tSec, a short \"caption\" and, when you can place it, a \"box\" [x1, y1, x2, y2] normalized 0-1000. An unmentioned issue needs at least one proof frame that actually shows the problem. One physical problem is one issue: if the same defect appears in several frames or angles, merge it into a single issue and list each frame in \"proofFrames\". Each issue has \"evidence\": one plain phrase of what its primary frame literally shows (e.g. \"black cable on the stage floor near the front edge\"). Title and detail may not claim more than the evidence plus what was said. Extent the frames don't show (down the steps, under the carpet) goes in detail as \"May extend to ...; check in person\", and severity follows what is seen.\n\n7. INVENTORY. Start from the segmentation counts, which are already summed across zones: each zone was counted once, from the frame that shows the most of it, and the frame list names each frame's zone when known. A zone seen again from another angle is the same zone, already counted once — do not count it again. Name the zone in \"zone\". Raise a count above the segmentation floor only for zones that never appear in the same frame and are clearly different places (different landmarks), not the same place from another angle. If zones may overlap, give \"range\" [segmentation floor, sum of the zone counts]. Never lower a count below the segmentation floor without saying why in the label. Add obvious countable items the segmentation missed (e.g. damaged chairs, choir chairs) only if you can count them in a frame. confidence is 0 to 1: copy the segmentation confidence, or your own estimate for items you added. \"method\": \"sam\" (copied), \"model\" (you counted) or \"sam+model\" (you adjusted a segmentation count). If your count and the segmentation count differ by more than 20%, give \"range\" [low, high] that contains count. \"zone\" names the area when it helps, e.g. \"stage\", \"main floor\". Labels are short and plural, e.g. \"Padded chairs (main floor)\". Each object is counted in exactly one row: never add a total or subtotal row on top of zone rows (no \"Padded chairs (total)\" next to \"Padded chairs (main floor)\").\n\n8. MATERIALS. List what is needed to fix the issues. qty is a string with units, e.g. \"2\", \"1 roll\", \"5 chairs\". \"forIssues\" lists the ranks it fixes; \"note\" adds anything else. Do not include prices.\n\n9. WORK ORDER. Ordered steps that fix every issue, safety first, and in the order the trade work must happen (leak source before ceiling tiles, electrical before paint, cables before flooring). order starts at 1. Use dependsOn (the order number of one earlier step) only when a step truly cannot start before another finishes. \"fixes\" lists the issue ranks the step fixes; every issue rank appears in at least one step. \"trade\" is who does it, e.g. \"volunteer\", \"electrician\", \"painter\". \"hours\" is a [low, high] labor estimate only when you can reason about it from what you see. Keep titles short and imperative; detail says what to do and why.\n\n10. HERO FRAME. Set heroFrameIndex to the widest, sharpest frame that shows the most of the area the work order changes. The \"after\" image is rendered from it.\n\n11. Set spaceName to \"{{space_name}}\" and generatedFrom to: \"Walkthrough video, {{frame_count}} frames, {{duration_sec}} s\" + (\", narrated\" if there is a transcript).\n\nPlain, specific language. No marketing words. Do not invent measurements, brands, or prices.\n";

/** Prompt 03 structured-output schema (has $defs; runReason inlines them). */
export const REASON_SCHEMA: Record<string, unknown> = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "spaceName",
    "generatedFrom",
    "inventory",
    "issues",
    "materials",
    "workOrder",
    "transcriptSummary",
    "saidVsSeen",
    "heroFrameIndex"
  ],
  "$defs": {
    "box": {
      "type": "array",
      "items": {
        "type": "number",
        "minimum": 0,
        "maximum": 1000
      },
      "minItems": 4,
      "maxItems": 4
    },
    "range": {
      "type": "array",
      "items": {
        "type": "number",
        "minimum": 0
      },
      "minItems": 2,
      "maxItems": 2
    },
    "status": {
      "type": "string",
      "enum": [
        "mentioned",
        "unmentioned",
        "mentioned_not_seen"
      ]
    }
  },
  "properties": {
    "spaceName": {
      "type": "string"
    },
    "generatedFrom": {
      "type": "string"
    },
    "transcriptSummary": {
      "type": [
        "string",
        "null"
      ]
    },
    "heroFrameIndex": {
      "type": "integer",
      "minimum": 0
    },
    "inventory": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "label",
          "count",
          "confidence"
        ],
        "properties": {
          "label": {
            "type": "string"
          },
          "count": {
            "type": "integer",
            "minimum": 0
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "range": {
            "$ref": "#/$defs/range"
          },
          "method": {
            "type": "string",
            "enum": [
              "sam",
              "model",
              "sam+model"
            ]
          },
          "zone": {
            "type": "string"
          }
        }
      }
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "rank",
          "title",
          "detail",
          "severity",
          "frameIndex",
          "frameTimeSec",
          "unmentioned",
          "status",
          "mention",
          "proofFrames",
          "confidence",
          "category"
        ],
        "properties": {
          "rank": {
            "type": "integer",
            "minimum": 1
          },
          "title": {
            "type": "string"
          },
          "detail": {
            "type": "string"
          },
          "severity": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ]
          },
          "frameIndex": {
            "type": "integer",
            "minimum": 0
          },
          "frameTimeSec": {
            "type": "number",
            "minimum": 0
          },
          "unmentioned": {
            "type": "boolean"
          },
          "status": {
            "$ref": "#/$defs/status"
          },
          "mention": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "quote",
                  "saidAtSec"
                ],
                "properties": {
                  "quote": {
                    "type": "string"
                  },
                  "saidAtSec": {
                    "type": "number",
                    "minimum": 0
                  }
                }
              }
            ]
          },
          "proofFrames": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "frameIndex",
                "tSec"
              ],
              "properties": {
                "frameIndex": {
                  "type": "integer",
                  "minimum": 0
                },
                "tSec": {
                  "type": "number",
                  "minimum": 0
                },
                "box": {
                  "$ref": "#/$defs/box"
                },
                "caption": {
                  "type": "string"
                }
              }
            }
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "category": {
            "type": "string",
            "enum": [
              "safety",
              "damage",
              "function",
              "cosmetic"
            ]
          },
          "hazard": {
            "type": "string",
            "enum": [
              "egress",
              "trip_cable",
              "water_stain",
              "exposed_wiring",
              "damaged_seating",
              "fire_extinguisher",
              "ada_path",
              "power_strip"
            ]
          },
          "tier": {
            "type": "string",
            "enum": [
              "urgent",
              "soon",
              "later"
            ]
          },
          "area": {
            "type": "string",
            "maxLength": 80
          },
          "evidence": {
            "type": "string",
            "maxLength": 160
          },
          "checklistKey": {
            "type": "string"
          }
        }
      }
    },
    "saidVsSeen": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "status",
          "said",
          "seen"
        ],
        "properties": {
          "status": {
            "$ref": "#/$defs/status"
          },
          "said": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "quote",
                  "atSec"
                ],
                "properties": {
                  "quote": {
                    "type": "string"
                  },
                  "atSec": {
                    "type": "number",
                    "minimum": 0
                  }
                }
              }
            ]
          },
          "seen": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "summary",
                  "frameIndex"
                ],
                "properties": {
                  "summary": {
                    "type": "string"
                  },
                  "frameIndex": {
                    "type": "integer",
                    "minimum": 0
                  }
                }
              }
            ]
          },
          "issueRank": {
            "type": "integer",
            "minimum": 1
          }
        }
      }
    },
    "materials": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "item",
          "qty"
        ],
        "properties": {
          "item": {
            "type": "string"
          },
          "qty": {
            "type": "string"
          },
          "note": {
            "type": "string"
          },
          "forIssues": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 1
            }
          }
        }
      }
    },
    "workOrder": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "order",
          "title",
          "detail"
        ],
        "properties": {
          "order": {
            "type": "integer",
            "minimum": 1
          },
          "title": {
            "type": "string"
          },
          "detail": {
            "type": "string"
          },
          "dependsOn": {
            "type": "integer",
            "minimum": 1
          },
          "fixes": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 1
            }
          },
          "trade": {
            "type": "string"
          },
          "hours": {
            "$ref": "#/$defs/range"
          }
        }
      }
    },
    "watch": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "detail",
          "frameIndex",
          "frameTimeSec"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "detail": {
            "type": "string"
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "frameIndex": {
            "type": "integer",
            "minimum": 0
          },
          "frameTimeSec": {
            "type": "number",
            "minimum": 0
          },
          "area": {
            "type": "string",
            "maxLength": 80
          },
          "evidence": {
            "type": "string",
            "maxLength": 160
          },
          "checklistKey": {
            "type": "string"
          },
          "proofFrames": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "frameIndex",
                "tSec"
              ],
              "properties": {
                "frameIndex": {
                  "type": "integer",
                  "minimum": 0
                },
                "tSec": {
                  "type": "number",
                  "minimum": 0
                },
                "box": {
                  "$ref": "#/$defs/box"
                },
                "caption": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    },
    "coverageNote": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 240
    }
  }
};

/** Prompt 05 template; placeholders are filled by buildCostPrompt. */
export const COST_PROMPT_TEMPLATE: string = "You are SightWork's cost estimator. A {{space_type}} needs the repairs below. Give unit prices and a labor rate for {{region}} so code can compute a rough cost range. Output JSON only, matching the schema.\n\nLABOR BASIS: {{labor_basis}} (volunteer = volunteers do general work for free and only licensed trades are paid; contractor = every step is paid; mixed = paid unless the trade is \"volunteer\").\n\nMATERIALS (index, item, quantity):\n{{materials_list}}\n\nWORK STEPS:\n{{steps_list}}\n\nDo this:\n1. For each material, give unitCost [low, high] in USD for ONE unit of the quantity's unit (one chair, one roll, one gallon), mid-grade, bought retail in or near {{region}}. Use web_search to ground prices at a home-improvement or supply retailer that serves {{region}}. Batch your searches: one search per retailer or material category, not one search per item; reuse one retailer's results across items where they cover several. If you can't find a price, give your best range, set \"grounded\": false, and keep the range wide. Never give a single number: low must be less than high unless the price is fixed.\n2. Give laborRate [low, high] USD per hour for the licensed trades in these steps in {{region}}. Use web_search. If the steps need no licensed trade and the basis is volunteer, still give the rate; code decides whether to use it.\n3. Give contingencyPct [low, high] between 10 and 20. Use the higher end when any issue is hidden damage (water, wiring) whose extent the video can't show.\n4. List assumptions in plain words, one per line: the region, mid-grade materials, the labor basis, anything you assumed about sizes or quantities, and which prices are not grounded.\n5. List sources: only pages you actually opened with web_search, each with title and url. Do not invent URLs.\n\nDo not compute a total. Do not quote brand-name products unless the search result was for one. Plain, specific language.\n";

/** Prompt 05 structured-output schema (flat: no $ref, no anyOf). */
export const COST_SCHEMA: Record<string, unknown> = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "unitCosts",
    "laborRate",
    "contingencyPct",
    "assumptions",
    "sources"
  ],
  "properties": {
    "unitCosts": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "materialIndex",
          "unit",
          "unitCost",
          "grounded",
          "sourceIndex"
        ],
        "properties": {
          "materialIndex": {
            "type": "integer",
            "minimum": 0
          },
          "unit": {
            "type": "string",
            "description": "What one unit is, e.g. \"chair\", \"roll\", \"gallon\""
          },
          "unitCost": {
            "type": "array",
            "items": {
              "type": "number",
              "minimum": 0
            },
            "minItems": 2,
            "maxItems": 2
          },
          "grounded": {
            "type": "boolean"
          },
          "sourceIndex": {
            "type": ["integer", "null"],
            "minimum": 0,
            "description": "Index into sources when grounded, else null"
          }
        }
      }
    },
    "laborRate": {
      "type": "array",
      "items": {
        "type": "number",
        "minimum": 0
      },
      "minItems": 2,
      "maxItems": 2
    },
    "contingencyPct": {
      "type": "array",
      "items": {
        "type": "number",
        "minimum": 10,
        "maximum": 20
      },
      "minItems": 2,
      "maxItems": 2
    },
    "assumptions": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1
    },
    "sources": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "url"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "url": {
            "type": "string"
          }
        }
      }
    }
  }
};

/** Fill one {{name}} placeholder in every occurrence. */
function fill(template: string, name: string, value: string): string {
  return template.split(`{{${name}}}`).join(value);
}

/** True when a template still has an unfilled {{placeholder}}. */
export function hasUnfilledPlaceholders(prompt: string): boolean {
  return /\{\{[a-z_]+\}\}/.test(prompt);
}

/**
 * Fail fast on a bad reason-step input, before a prompt is built.
 * Only the fields the prompt actually prints are checked: tSec (the
 * frame list prints t only) and the scalar fields. dataUrl is
 * intentionally unchecked here — runReason validates it before the
 * model call, and this builder never prints it.
 * A spaceName or spaceType containing a newline printed verbatim
 * would split the prompt line that carries it, so such values now
 * fail fast. The transcript is intentionally unchecked for newlines:
 * it is multi-line by design.
 * A spaceName containing a double quote printed verbatim would close
 * the quoted name in the template (called "{{space_name}}" and step
 * 11's Set spaceName to "{{space_name}}"), so such values now fail
 * fast too. spaceType is printed unquoted everywhere in this template,
 * so a quote there is left alone.
 * A spaceName or spaceType containing a {{placeholder}} would be
 * expanded by a later fill() pass (fills run in order: space_type,
 * space_checklist, space_name, duration_sec, frame_count, frame_list,
 * segmentation_json, transcript), so a {{transcript}} token in the
 * space name used to print the whole transcript inside the quoted
 * name, and a {{space_name}} token in the space type used to print
 * the space name there; such values now fail fast. The transcript
 * itself is filled last, so a token in it is caught by the final
 * unfilled-placeholder check instead.
 * A segmentation count label is printed verbatim as JSON and filled
 * before the transcript, so a {{transcript}} token in a label would
 * be expanded by the transcript fill instead of caught: the label
 * used to print the whole transcript inside the SEGMENTATION
 * section. Other tokens in a label are caught by the final check,
 * but the label is rejected for any {{...}} token here so the
 * failure names the field instead of surfacing as a generic
 * unfilled-placeholder error.
 * A segmentation count or confidence that is not a finite number
 * would be printed verbatim as JSON, and JSON.stringify turns NaN
 * and Infinity into null, so a bad count used to reach the model
 * as count null instead of failing fast; a negative or fractional
 * count, or a confidence outside 0..1, is likewise not a count the
 * segment step can produce (it sums whole instances and averages
 * scores), so such values now fail fast too.
 * A flaggedFrames entry that is not a whole frame index >= 0 would
 * be printed verbatim as JSON (NaN/Infinity as null, and a string
 * token expanded by the later transcript fill), so such entries now
 * fail fast too; the segment step only flags integer frame indices.
 * A segmentation counts entry that is not an object at all (null, a
 * string, a number) used to slip past the per-field guards, which
 * only check label/count/confidence when the entry is an object, so
 * it was printed verbatim as JSON inside the SEGMENTATION section;
 * such entries now fail fast too, naming the entry index.
 * A segmentation counts field that is not an array at all (a string,
 * an object, a number) used to slip past the per-entry guards, which
 * only run when counts is an array, so it was printed verbatim as
 * JSON inside the SEGMENTATION section; such values now fail fast
 * too, naming the field.
 * A segmentation counts entry whose label is not a string at all
 * (a number, null, an object, or missing) used to slip past the
 * placeholder guard, which only runs when the label is a string,
 * so it was printed verbatim as JSON inside the SEGMENTATION
 * section (a number label as "label":5, a missing label dropped
 * from the JSON entirely); such labels now fail fast too, naming
 * the entry index.
 * The whole segmentation object is printed verbatim as JSON, so a
 * {{transcript}} token in any part of it the per-field guards do
 * not cover (an extra field on a counts entry, or an extra
 * top-level field) used to be expanded by the later transcript
 * fill instead of failing: an entry zone of "stage
 * {{transcript}}" printed the whole transcript inside the
 * SEGMENTATION section. Such tokens now fail fast too, naming
 * the segmentation object; a token in a label still throws the
 * label error first.
 * A segmentation value that is an array at all used to slip past the
 * object check, because arrays are objects in JavaScript, so it was
 * printed verbatim as JSON ("[]" for an empty array, or a bare list
 * of counts) inside the SEGMENTATION section instead of the counts
 * object the model expects; such values now fail fast too, naming
 * the field.
 * A segmentation counts entry that is an array at all used to slip
 * past the object check the same way, and the per-field guards read
 * label, count and confidence straight off the array, so an entry
 * carrying those fields as array properties passed every check and
 * was then printed verbatim as JSON — but JSON.stringify drops array
 * properties, so it reached the model as an empty "[]" and its count
 * was silently lost; such entries now fail fast too, naming the
 * entry index.
 * Two counts entries sharing one label used to print verbatim as
 * JSON, so the model saw the same item counted twice and could add
 * the two counts together; such a repeat now fails fast too, naming
 * the second entry's index (the cost builder already rejects a
 * repeated material item and a repeated step title the same way).
 * A flagged frame listed twice used to print verbatim as JSON, so
 * the model was told twice to look hardest at the same frame; the
 * segment step only flags each frame once (a sorted, unique set in
 * segment.ts), so such a repeat now fails fast too, naming the
 * second entry's index. A flagged index is not range-checked
 * against the frame list here: the existing flagged-frames test
 * builds cleanly with index 3 on a one-frame input, so a flagged
 * index is not required to be a sampled-frame position.
 * A segmentation counts label that is empty or only whitespace
 * used to print verbatim as JSON, so the model saw a count row
 * with no item name (\"label\":\"\") and could not attach it to
 * an inventory item; such labels now fail fast too, naming the
 * entry index. The check runs on the trimmed label, so a
 * whitespace-only label fails the same way; the uniqueness check
 * already normalizes case and whitespace.
 * A non-null segmentation with no counts field at all used to slip
 * past the counts guard, which only ran when counts was present and
 * not an array, so it was printed verbatim as JSON with no counts
 * at all ({"flaggedFrames":[...]}) while the template tells the
 * model the segmentation counts are the inventory floor; the model
 * could then invent its own counts with nothing to floor them
 * against. SegmentationResult requires counts (and runReason's own
 * validator already rejects a missing counts array before any paid
 * call), so a direct buildReasonPrompt caller bypassing runReason
 * gets the same fail-fast here, naming the field. Null segmentation
 * still builds the explicit no-data prompt.
 * A non-null segmentation with no flaggedFrames field at all used to
 * slip past the flaggedFrames guard, which only ran when flaggedFrames
 * was present, so it was printed verbatim as JSON with no flagged
 * frames at all ({"counts":[...]}) while the template tells the model
 * to look hardest at flaggedFrames; the model then had no hazard
 * frames to look hardest at. SegmentationResult requires
 * flaggedFrames (and runReason's own validator already rejects a
 * missing flaggedFrames array before any paid call), so a direct
 * buildReasonPrompt caller bypassing runReason gets the same fail-fast
 * here, naming the field. Null segmentation still builds the
 * explicit no-data prompt.
 * A segmentation field that is undefined at all used to slip past
 * the object check, which only ran when segmentation was neither
 * null nor undefined, so it built the explicit no-data prompt
 * ("the segmentation step failed") even though the segment step
 * never ran and never failed — the caller simply omitted the
 * field, and the model counted from the frames with no SAM floor
 * and no warning that the floor was missing rather than failed.
 * ReasonInput requires segmentation (an object or null, not
 * optional), and runReason's own validator already rejects an
 * undefined segmentation before any paid call, so a direct
 * buildReasonPrompt caller bypassing runReason gets the same
 * fail-fast here, naming the field. Null segmentation still builds
 * the explicit no-data prompt.
 * A transcript field that is undefined at all used to slip past
 * the string-or-null check, which only ran when transcript was
 * neither null nor undefined, so it built the prompt with the
 * literal "(no narration)" even though the transcribe step never
 * ran and never reported silence — the caller simply omitted the
 * field, and the model treated every issue as unmentioned with no
 * warning that the narration was missing rather than silent.
 * ReasonInput requires transcript (a string or null, not
 * optional), and runReason's own validator already rejects an
 * undefined transcript before any paid call, so a direct
 * buildReasonPrompt caller bypassing runReason gets the same
 * fail-fast here, naming the field. Null transcript still builds
 * the explicit "(no narration)" prompt.
 * A transcript that is blank at all (an empty string, or only
 * whitespace) used to slip past the string-or-null check, so it
 * built the prompt with an empty TRANSCRIPT section — neither the
 * speaker's words nor the explicit "(no narration)" marker, so
 * step 2's null-if-no-narration rule had nothing to key on and the
 * model could treat an empty section as silence or invent
 * narration. runPlan's own validator already rejects a blank
 * transcript before any paid call, so a direct buildReasonPrompt
 * caller bypassing runPlan gets the same fail-fast here, naming
 * the field. Null transcript still builds the explicit
 * "(no narration)" prompt, and a non-blank string still builds.
 * A space name or space type that is blank at all (an empty string,
 * or only whitespace) used to slip past the string, newline and
 * placeholder checks, so buildReasonPrompt silently fell back to
 * "Walkthrough" or "room" instead of failing — the caller never
 * learned the name was blank, and the model planned a generic
 * Walkthrough rather than the space that was filmed. runReason's
 * own validator already rejects a blank space name or space type
 * when given before any paid call, so a direct buildReasonPrompt
 * caller bypassing runReason gets the same fail-fast here, naming
 * the field. An omitted field still falls back to the default.
 */
export function validateReasonPromptInput(input: ReasonInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("buildReasonPrompt: input must be an object");
  }
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new Error("buildReasonPrompt: frames must be a non-empty array");
  }
  input.frames.forEach((f, i) => {
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.tSec !== "number" ||
      !Number.isFinite(f.tSec) ||
      f.tSec < 0
    ) {
      throw new Error(`buildReasonPrompt: frames[${i}].tSec must be a finite number >= 0`);
    }
    if (
      f.zoneId !== undefined &&
      (!Number.isInteger(f.zoneId) || f.zoneId < 0)
    ) {
      throw new Error(`buildReasonPrompt: frames[${i}].zoneId must be a whole number >= 0 when given`);
    }
  });
  if (
    typeof input.durationSec !== "number" ||
    !Number.isFinite(input.durationSec) ||
    input.durationSec < 0
  ) {
    throw new Error(`buildReasonPrompt: durationSec must be a finite number >= 0, got ${input.durationSec}`);
  }
  for (const field of ["spaceName", "spaceType"] as const) {
    const v = input[field];
    if (v !== undefined && typeof v !== "string") {
      throw new Error(`buildReasonPrompt: ${field} must be a string when given`);
    }
    if (typeof v === "string" && /[\r\n]/.test(v)) {
      throw new Error(`buildReasonPrompt: ${field} must not contain a newline`);
    }
    if (typeof v === "string" && /\{\{[a-z_]+\}\}/.test(v)) {
      throw new Error(`buildReasonPrompt: ${field} must not contain a {{...}} placeholder`);
    }
    if (typeof v === "string" && v.trim().length === 0) {
      throw new Error(`buildReasonPrompt: ${field} must not be blank when given`);
    }
  }
  if (typeof input.spaceName === "string" && input.spaceName.includes('"')) {
    throw new Error('buildReasonPrompt: spaceName must not contain a double quote');
  }
  if (
    input.transcript !== null &&
    typeof input.transcript !== "string"
  ) {
    throw new Error("buildReasonPrompt: transcript must be a string or null");
  }
  if (
    typeof input.transcript === "string" &&
    input.transcript.trim().length === 0
  ) {
    throw new Error("buildReasonPrompt: transcript must not be blank");
  }
  if (
    input.segmentation !== null &&
    typeof input.segmentation !== "object"
  ) {
    throw new Error("buildReasonPrompt: segmentation must be an object or null");
  }
  if (Array.isArray(input.segmentation)) {
    throw new Error(
      "buildReasonPrompt: segmentation must be an object, not an array",
    );
  }
  if (
    input.segmentation &&
    typeof input.segmentation === "object" &&
    !Array.isArray((input.segmentation as { counts?: unknown }).counts)
  ) {
    throw new Error("buildReasonPrompt: segmentation.counts must be an array");
  }
  if (
    input.segmentation &&
    typeof input.segmentation === "object" &&
    Array.isArray((input.segmentation as { counts?: unknown }).counts)
  ) {
    const seenLabels = new Set<string>();
    (input.segmentation as { counts: unknown[] }).counts.forEach((c, i) => {
      if (!c || typeof c !== "object") {
        throw new Error(
          `buildReasonPrompt: segmentation.counts[${i}] must be an object`,
        );
      }
      if (Array.isArray(c)) {
        throw new Error(
          `buildReasonPrompt: segmentation.counts[${i}] must be an object, not an array`,
        );
      }
      if (typeof (c as { label?: unknown }).label !== "string") {
        throw new Error(
          `buildReasonPrompt: segmentation.counts[${i}].label must be a string`,
        );
      }
      if (
        c &&
        typeof c === "object" &&
        typeof (c as { label?: unknown }).label === "string" &&
        /\{\{[a-z_]+\}\}/.test((c as { label: string }).label)
      ) {
        throw new Error(
          `buildReasonPrompt: segmentation.counts[${i}].label must not contain a {{...}} placeholder`,
        );
      }
      if (
        c &&
        typeof c === "object" &&
        typeof (c as { label?: unknown }).label === "string"
      ) {
        const label = (c as { label: string }).label;
        const normalizedLabel = label.trim().toLowerCase();
        if (normalizedLabel === "") {
          throw new Error(
            `buildReasonPrompt: segmentation.counts[${i}].label must not be empty`,
          );
        }
        if (seenLabels.has(normalizedLabel)) {
          throw new Error(
            `buildReasonPrompt: segmentation.counts[${i}].label must be unique`,
          );
        }
        seenLabels.add(normalizedLabel);
      }
      if (c && typeof c === "object") {
        const count = (c as { count?: unknown }).count;
        if (
          typeof count !== "number" ||
          !Number.isInteger(count) ||
          count < 0
        ) {
          throw new Error(
            `buildReasonPrompt: segmentation.counts[${i}].count must be a whole number >= 0`,
          );
        }
        const confidence = (c as { confidence?: unknown }).confidence;
        if (
          typeof confidence !== "number" ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        ) {
          throw new Error(
            `buildReasonPrompt: segmentation.counts[${i}].confidence must be a finite number between 0 and 1`,
          );
        }
      }
    });
  }
  if (input.segmentation && typeof input.segmentation === "object") {
    const flagged = (input.segmentation as { flaggedFrames: unknown })
      .flaggedFrames;
    if (!Array.isArray(flagged)) {
      throw new Error("buildReasonPrompt: segmentation.flaggedFrames must be an array");
    }
    const seenFlagged = new Set<number>();
    flagged.forEach((f, i) => {
      if (typeof f !== "number" || !Number.isInteger(f) || f < 0) {
        throw new Error(
          `buildReasonPrompt: segmentation.flaggedFrames[${i}] must be a whole number >= 0`,
        );
      }
      if (seenFlagged.has(f)) {
        throw new Error(
          `buildReasonPrompt: segmentation.flaggedFrames[${i}] must be unique`,
        );
      }
      seenFlagged.add(f);
    });
  }
  if (
    input.segmentation &&
    typeof input.segmentation === "object" &&
    /\{\{[a-z_]+\}\}/.test(JSON.stringify(input.segmentation))
  ) {
    throw new Error(
      "buildReasonPrompt: segmentation must not contain a {{...}} placeholder",
    );
  }
}

/**
 * Fail fast on a bad cost-step input, before a prompt is built.
 * A material with no item/qty or a step with no title/order used to
 * print verbatim as item="undefined" / order=undefined in the prompt,
 * and a non-string note printed verbatim as note="[object Object]".
 * Region is required here: this builder is only called with a region
 * (runPlan guards the call, estimateCost returns null without one).
 * A reversed hours pair printed verbatim as hours=[5, 2]; it now fails fast.
 * A step order of 0, a negative, or a fraction printed verbatim as
 * order=0; it now fails fast (WorkStep order is 1-based).
 * Negative hours printed verbatim as hours=[-2, 3]; they now fail
 * fast (labor hours are never negative).
 * Two steps sharing one order printed verbatim as order=1 twice; they now
 * fail fast (each work step has its own 1-based order).
 * Orders skipping a number or starting above 1 printed verbatim as
 * order=2, order=4; they now fail fast (the work order runs 1..N with
 * no gaps, so a missing number is a missing fix).
 * Two steps sharing one title printed verbatim as title="Fix leak"
 * twice; they now fail fast (each work step has its own title, so the
 * cost model and the step ticks cannot merge two different fixes).
 * Two materials sharing one item printed verbatim as item="paint"
 * twice; they now fail fast (each materials line is its own item, so
 * the cost model cannot price the same item twice).
 * Two materials sharing one item apart from case printed verbatim as
 * item="paint" and item="Paint" twice; they now fail fast too (the
 * comparison is trimmed and lowercased, so case alone cannot make
 * one item look like two lines to price).
 * Two steps sharing one title apart from case printed verbatim as
 * title="Fix leak" and title="fix leak" twice; they now fail fast
 * too (the comparison is trimmed and lowercased, so case alone
 * cannot make one fix look like two steps to tick).
 * A material qty starting with zero printed verbatim as qty="0";
 * it now fails fast (a listed material is needed in some amount, so
 * a zero qty would price it at nothing and drop it from the spend).
 * A material qty starting with a minus sign printed verbatim as
 * qty="-2 gallons"; it now fails fast (a negative qty would price
 * as a credit, not a need).
 * A material qty with a malformed thousands group printed verbatim as
 * qty="12,34 chairs"; it now fails fast (parseQty would silently read
 * it as 12, dropping the rest, so the spend would understate the need).
 * A material item, qty or note, or a work step title or trade,
 * containing a newline printed verbatim would split one prompt line
 * into two, so the cost model could read a phantom second entry;
 * such fields now fail fast.
 * A region or space type containing a newline printed verbatim would
 * split the prompt line that carries it, so the cost model could read
 * a phantom line; such values now fail fast too.
 * A material item containing a double quote is escaped as \" when
 * printed, so the item="..." field cannot be closed early; an inch
 * mark like 2" pipe still builds, as 2\" pipe.
 * A material note containing a double quote is escaped the same way,
 * so the note="..." field cannot be closed early either.
 * A work step title containing a double quote is escaped the same way,
 * so the title="..." field cannot be closed early either.
 * A work step trade containing a double quote is escaped the same way,
 * so the trade="..." field cannot be closed early either.
 * A material qty containing a double quote is escaped the same way,
 * so the qty="..." field cannot be closed early either.
 * A region, space type, material item/qty/note, or work step
 * title/trade containing a {{placeholder}} would be expanded by a
 * later fill() pass (fills run in order: space_type, region,
 * labor_basis, materials_list, steps_list), so a {{steps_list}} token
 * in an item would print the whole steps list inside that item line;
 * such values now fail fast.
 * A space type that is only whitespace used to slip past the string,
 * newline and placeholder checks, so buildCostPrompt silently fell
 * back to "room" — the caller never learned the type was blank, and
 * the model priced a generic room rather than the space that was
 * filmed. runPlan's own validator already rejects a spaces-only
 * space type when given before any paid call, so a direct
 * buildCostPrompt caller bypassing runPlan gets the same fail-fast
 * here, naming the field. An empty string still means "not given"
 * (runPlan's convention) and falls back to the default, as does an
 * omitted space type.
 */
export function validateCostPromptInput(input: CostInput, spaceType?: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("buildCostPrompt: input must be an object");
  }
  if (typeof input.region !== "string" || input.region.trim().length === 0) {
    throw new Error("buildCostPrompt: region must be a non-empty string");
  }
  if (/[\r\n]/.test(input.region)) {
    throw new Error("buildCostPrompt: region must not contain a newline");
  }
  if (/\{\{[a-z_]+\}\}/.test(input.region)) {
    throw new Error("buildCostPrompt: region must not contain a {{...}} placeholder");
  }
  if (spaceType !== undefined && typeof spaceType !== "string") {
    throw new Error("buildCostPrompt: spaceType must be a string when given");
  }
  if (typeof spaceType === "string" && /[\r\n]/.test(spaceType)) {
    throw new Error("buildCostPrompt: spaceType must not contain a newline");
  }
  if (typeof spaceType === "string" && /\{\{[a-z_]+\}\}/.test(spaceType)) {
    throw new Error("buildCostPrompt: spaceType must not contain a {{...}} placeholder");
  }
  if (
    typeof spaceType === "string" &&
    spaceType.length > 0 &&
    spaceType.trim().length === 0
  ) {
    throw new Error("buildCostPrompt: spaceType must not be blank when given");
  }
  if (
    input.laborBasis !== undefined &&
    input.laborBasis !== "volunteer" &&
    input.laborBasis !== "contractor" &&
    input.laborBasis !== "mixed"
  ) {
    throw new Error(`buildCostPrompt: laborBasis must be volunteer, contractor or mixed, got ${input.laborBasis}`);
  }
  if (!Array.isArray(input.materials)) {
    throw new Error("buildCostPrompt: materials must be an array");
  }
  const seenMaterials = new Set<string>();
  input.materials.forEach((m, i) => {
    if (
      !m ||
      typeof m !== "object" ||
      typeof m.item !== "string" ||
      m.item.trim().length === 0 ||
      typeof m.qty !== "string" ||
      m.qty.trim().length === 0
    ) {
      throw new Error(`buildCostPrompt: materials[${i}] must have a non-empty item and qty`);
    }
    for (const field of ["item", "qty", "note"] as const) {
      const value = m[field];
      if (typeof value === "string" && /[\r\n]/.test(value)) {
        throw new Error(
          `buildCostPrompt: materials[${i}].${field} must not contain a newline`,
        );
      }
      if (typeof value === "string" && /\{\{[a-z_]+\}\}/.test(value)) {
        throw new Error(
          `buildCostPrompt: materials[${i}].${field} must not contain a {{...}} placeholder`,
        );
      }
    }
    const qtyMatch = /^\s*(\d+(?:\.\d+)?)/.exec(m.qty);
    if (qtyMatch && Number(qtyMatch[1]) === 0) {
      throw new Error(`buildCostPrompt: materials[${i}].qty must be greater than zero when it starts with a number`);
    }
    if (m.qty.trim().startsWith("-")) {
      throw new Error(`buildCostPrompt: materials[${i}].qty must not be negative`);
    }
    const commaGroup = /^\s*(\d[\d,]*)/.exec(m.qty);
    if (commaGroup && commaGroup[1].includes(",")) {
      if (!/^\d{1,3}(,\d{3})+$/.test(commaGroup[1])) {
        throw new Error(`buildCostPrompt: materials[${i}].qty has a malformed thousands group`);
      }
    }
    if (seenMaterials.has(m.item.trim().toLowerCase())) {
      throw new Error(`buildCostPrompt: materials[${i}].item must be unique`);
    }
    seenMaterials.add(m.item.trim().toLowerCase());
    if (m.note !== undefined && typeof m.note !== "string") {
      throw new Error(`buildCostPrompt: materials[${i}].note must be a string when given`);
    }
  });
  if (!Array.isArray(input.workOrder)) {
    throw new Error("buildCostPrompt: workOrder must be an array");
  }
  if (input.workOrder.length === 0) {
    throw new Error("buildCostPrompt: workOrder must be non-empty");
  }
  const seenOrders = new Set<number>();
  const seenTitles = new Set<string>();
  input.workOrder.forEach((s, i) => {
    if (
      !s ||
      typeof s !== "object" ||
      typeof s.title !== "string" ||
      s.title.trim().length === 0 ||
      typeof s.order !== "number" ||
      !Number.isFinite(s.order)
    ) {
      throw new Error(`buildCostPrompt: workOrder[${i}] must have a finite order and a non-empty title`);
    }
    for (const field of ["title", "trade"] as const) {
      const value = s[field];
      if (typeof value === "string" && /[\r\n]/.test(value)) {
        throw new Error(
          `buildCostPrompt: workOrder[${i}].${field} must not contain a newline`,
        );
      }
      if (typeof value === "string" && /\{\{[a-z_]+\}\}/.test(value)) {
        throw new Error(
          `buildCostPrompt: workOrder[${i}].${field} must not contain a {{...}} placeholder`,
        );
      }
    }
    if (!Number.isInteger(s.order) || s.order < 1) {
      throw new Error(`buildCostPrompt: workOrder[${i}].order must be a positive integer`);
    }
    if (seenOrders.has(s.order)) {
      throw new Error(`buildCostPrompt: workOrder[${i}].order must be unique`);
    }
    seenOrders.add(s.order);
    if (seenTitles.has(s.title.trim().toLowerCase())) {
      throw new Error(`buildCostPrompt: workOrder[${i}].title must be unique`);
    }
    seenTitles.add(s.title.trim().toLowerCase());
    if (
      s.trade !== undefined &&
      (typeof s.trade !== "string" || s.trade.trim().length === 0)
    ) {
      throw new Error(
        `buildCostPrompt: workOrder[${i}].trade must be a non-empty string when given`,
      );
    }
    if (
      s.hours !== undefined &&
      (!Array.isArray(s.hours) ||
        s.hours.length !== 2 ||
        s.hours.some((h) => typeof h !== "number" || !Number.isFinite(h)))
    ) {
      throw new Error(`buildCostPrompt: workOrder[${i}].hours must be [low, high] finite numbers when given`);
    }
    if (
      s.hours !== undefined &&
      Array.isArray(s.hours) &&
      s.hours.length === 2 &&
      typeof s.hours[0] === "number" &&
      typeof s.hours[1] === "number" &&
      s.hours[0] > s.hours[1]
    ) {
      throw new Error(`buildCostPrompt: workOrder[${i}].hours must be [low, high] with low <= high`);
    }
    if (
      s.hours !== undefined &&
      Array.isArray(s.hours) &&
      s.hours.length === 2 &&
      typeof s.hours[0] === "number" &&
      s.hours[0] < 0
    ) {
      throw new Error(`buildCostPrompt: workOrder[${i}].hours must be >= 0`);
    }
  });
  const sortedOrders = [...seenOrders].sort((a, b) => a - b);
  if (sortedOrders.some((order, i) => order !== i + 1)) {
    throw new Error("buildCostPrompt: workOrder orders must start at 1 with no gaps");
  }
}

/** Space-specific extra checks for prompt 03 step 1 (2026-10-30 proposal). Unknown types get the general checklist only. */
function spaceChecklistFor(spaceType: string): string {
  const map: Record<string, string> = {
    "church sanctuary": "stage edge, baptistry, AV booth, pew or chair rows, platform steps",
    classroom: "outlets at child height, storage stability, window blinds cords",
    kitchen: "hood and filters, sink and drain, extinguisher near cooking, floor drains, food-safe surfaces, plumbing leaks, corroded valves and water heater",
  };
  return map[spaceType] ?? "nothing beyond the checklist above";
}

/**
 * Build the finished prompt 03 for one reason step. Variable table from
 * prompt 03: space_name falls back to "Walkthrough", space_type to
 * "room", transcript to the literal "(no narration)" when
 * null, frame_list one line per frame in array order.
 */
export function buildReasonPrompt(input: ReasonInput): string {
  validateReasonPromptInput(input);
  const spaceName = input.spaceName && input.spaceName.trim() ? input.spaceName : "Walkthrough";
  const spaceType = input.spaceType && input.spaceType.trim() ? input.spaceType : "room";
  const frameList = input.frames
    .map(
      (f, i) =>
        `frameIndex=${i} t=${f.tSec}s${typeof f.zoneId === "number" ? ` zone=${f.zoneId}` : ""}`,
    )
    .join("\n");
  let prompt = REASON_PROMPT_TEMPLATE;
  prompt = fill(prompt, "space_type", spaceType);
  prompt = fill(prompt, "space_checklist", spaceChecklistFor(spaceType));
  prompt = fill(prompt, "space_name", spaceName);
  prompt = fill(prompt, "duration_sec", String(input.durationSec));
  prompt = fill(prompt, "frame_count", String(input.frames.length));
  prompt = fill(prompt, "frame_list", frameList);
  // No segmentation (the segment step failed): say so explicitly in
  // the SEGMENTATION section, so the model counts from the frames
  // instead of trusting counts that are not there. The template text
  // itself is the spec wording and stays untouched; only this
  // placeholder fill changes.
  const segmentationJson = input.segmentation
    ? JSON.stringify(input.segmentation)
    : "(no segmentation data: the segmentation step failed, so there are no SAM counts and no flaggedFrames; count objects yourself from the frames, and use method \"model\" for every inventory item)";
  prompt = fill(prompt, "segmentation_json", segmentationJson);
  prompt = fill(prompt, "transcript", input.transcript ?? "(no narration)");
  if (hasUnfilledPlaceholders(prompt)) {
    throw new Error("buildReasonPrompt: prompt still has unfilled placeholders");
  }
  return prompt;
}

/**
 * Build the finished prompt 05 for one cost step. Variable table from
 * prompt 05: labor_basis falls back to "volunteer". CostInput carries no
 * spaceType, so the caller passes PlanRequest.spaceType (default
 * "room"). Only called with a region: estimateCost returns
 * null without one, so no prompt is built for a region-less request.
 */
export function buildCostPrompt(input: CostInput, spaceType = "room"): string {
  validateCostPromptInput(input, spaceType);
  const space = spaceType && spaceType.trim() ? spaceType : "room";
  const laborBasis = input.laborBasis ?? "volunteer";
  const materialsList = input.materials
    .map((m, i) => `i=${i} item="${m.item.replaceAll('"', '\\"')}" qty="${m.qty.replaceAll('"', '\\"')}" note="${(m.note ?? "").replaceAll('"', '\\"')}"`)
    .join("\n");
  const stepsList = input.workOrder
    .map(
      (s) =>
        `order=${s.order} title="${s.title.replaceAll('"', '\\"')}" trade="${(s.trade ?? "unknown").replaceAll('"', '\\"')}" hours=${
          s.hours ? `[${s.hours[0]}, ${s.hours[1]}]` : "unknown"
        }`,
    )
    .join("\n");
  let prompt = COST_PROMPT_TEMPLATE;
  prompt = fill(prompt, "space_type", space);
  prompt = fill(prompt, "region", input.region ?? "");
  prompt = fill(prompt, "labor_basis", laborBasis);
  prompt = fill(prompt, "materials_list", materialsList);
  prompt = fill(prompt, "steps_list", stepsList);
  if (hasUnfilledPlaceholders(prompt)) {
    throw new Error("buildCostPrompt: prompt still has unfilled placeholders");
  }
  return prompt;
}








