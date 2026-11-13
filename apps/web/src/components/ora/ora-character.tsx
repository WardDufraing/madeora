"use client";

import { defaultOraPalette, oraPaletteVariables, type OraPaletteKey } from "@madeora/design-tokens";
import { useEffect, useId, useState, type CSSProperties } from "react";

import {
  briefReactionMilliseconds,
  defaultOraMotion,
  type OraExpression,
  type OraMotionMode,
} from "@/ora/types";

import { cx } from "../ui/cx";

const neutralBrows = "M 139 136 Q 145 131 150 133 M 207 132 Q 213 130 218 135";
const browPaths: Partial<Record<OraExpression, string>> = {
  thinking: "M 139 136 Q 145 134 150 136 M 206 129 Q 213 125 219 129",
  surprised: "M 138 127 Q 145 121 152 125 M 205 125 Q 212 121 220 127",
  concerned: "M 138 137 Q 145 135 152 130 M 205 130 Q 212 135 220 137",
};
const neutralSmile = "M 171 189 Q 180 197 189 189";
const smilePaths: Partial<Record<OraExpression, string>> = {
  thinking: "M 174 192 Q 181 190 188 192",
  concerned: "M 171 195 Q 180 186 189 195",
  happy: "M 168 187 Q 180 201 192 187",
};
const openMouth = "M 167 185 Q 180 190 193 185 Q 191 207 180 207 Q 169 207 167 185";
const roundMouth = "M 180 184 C 191 184 191 202 180 202 C 169 202 169 184 180 184";

export interface OraCharacterProps {
  /** One of the nine palette keys; Heather until the person chooses. */
  readonly palette?: OraPaletteKey;
  readonly expression?: OraExpression;
  /** The person's motion mode; the system's reduced-motion setting always wins over it. */
  readonly motion?: OraMotionMode;
  /** Change it to replay the same expression (a new greeting, another completion). */
  readonly replayKey?: number;
  /**
   * The accessible name when Ora stands alone. Leave it out when nearby text already names Ora:
   * the character is then hidden from assistive technology. Blinks and frames are never announced.
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * Ora, the small floating character (Ora design handoff). The body path, hand positions, gradients
 * and motion are the approved reference, ported as it is; only the palette changes. Several can
 * be on one page: every gradient and filter id is unique to the instance. Brief reactions (cheer,
 * wave, surprised, happy) return to calm floating by themselves; sustained expressions (curious,
 * thinking, concerned) are held by the caller for as long as the real situation lasts, so the
 * thinking face always follows an operation that is actually running.
 */
export function OraCharacter({
  palette = defaultOraPalette,
  expression = "idle",
  motion = defaultOraMotion,
  replayKey = 0,
  label,
  className,
}: OraCharacterProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const token = `${expression}:${String(replayKey)}`;
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const brief = briefReactionMilliseconds[expression];
  const shown: OraExpression = brief !== undefined && settledFor === token ? "idle" : expression;

  useEffect(() => {
    if (brief === undefined) return;
    const timer = window.setTimeout(() => {
      setSettledFor(token);
    }, brief);
    return () => {
      window.clearTimeout(timer);
    };
  }, [brief, token]);

  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const style = oraPaletteVariables(palette) as CSSProperties;
  const stop = (variable: string) => ({ stopColor: `var(${variable})` });

  return (
    <div
      className={cx("ora-char", className)}
      data-state={shown}
      data-motion={motion}
      data-palette={palette}
      style={style}
      // Remounting restarts a one-time animation, so the same expression can be replayed.
      key={replayKey}
    >
      <svg
        viewBox="0 0 360 320"
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? true : undefined}
        focusable="false"
      >
        <defs>
          <radialGradient id={id("body")} cx="32%" cy="25%" r="76%" fx="30%" fy="22%">
            <stop offset="0" style={stop("--ora-body-0")} />
            <stop offset=".32" style={stop("--ora-body-1")} />
            <stop offset=".64" style={stop("--ora-body-2")} />
            <stop offset=".85" style={stop("--ora-body-3")} />
            <stop offset="1" style={stop("--ora-body-4")} />
          </radialGradient>
          <radialGradient id={id("arm")} cx="27%" cy="24%" r="83%">
            <stop offset="0" style={stop("--ora-body-0")} />
            <stop offset=".5" style={stop("--ora-body-1")} />
            <stop offset=".86" style={stop("--ora-body-3")} />
            <stop offset="1" style={stop("--ora-body-4")} />
          </radialGradient>
          <radialGradient id={id("eye")} cx="32%" cy="22%" r="80%">
            <stop offset="0" style={stop("--ora-eye-0")} />
            <stop offset=".45" style={stop("--ora-eye-1")} />
            <stop offset="1" style={stop("--ora-eye-2")} />
          </radialGradient>
          <radialGradient id={id("light")}>
            <stop offset="0" style={stop("--ora-light")} stopOpacity=".6" />
            <stop offset="1" style={stop("--ora-light")} stopOpacity="0" />
          </radialGradient>
          <filter id={id("soft-shadow")} x="-60%" y="-100%" width="220%" height="300%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <filter id={id("eye-shadow")} x="-60%" y="-40%" width="220%" height="200%">
            <feDropShadow
              dx="0"
              dy="1.6"
              stdDeviation="1.2"
              floodColor="var(--ora-eye-shadow)"
              floodOpacity=".5"
            />
          </filter>
        </defs>
        <ellipse
          className="shadow"
          cx="180"
          cy="290"
          rx="65"
          ry="8"
          fill="currentColor"
          opacity=".17"
          filter={url("soft-shadow")}
        />
        <g className="orb">
          <g className="arm arm-a">
            <ellipse className="hand-blob" cx="60" cy="177" rx="14" ry="18" fill={url("arm")} />
          </g>
          <g className="arm arm-b">
            <ellipse className="hand-blob" cx="300" cy="177" rx="14" ry="18" fill={url("arm")} />
          </g>
          <path
            d="M 180 64 C 239 61 279 103 280 166 C 281 225 241 261 181 263 C 120 264 80 224 81 168 C 82 112 119 66 180 64 Z"
            fill={url("body")}
          />
          <ellipse
            cx="136"
            cy="111"
            rx="51"
            ry="37"
            fill={url("light")}
            transform="rotate(-32 136 111)"
          />
          <ellipse
            cx="132"
            cy="187"
            rx="14"
            ry="7"
            style={{ fill: "var(--ora-blush)" }}
            opacity=".23"
          />
          <ellipse
            cx="228"
            cy="187"
            rx="14"
            ry="7"
            style={{ fill: "var(--ora-blush)" }}
            opacity=".23"
          />
          <g className="gaze">
            <path className="brows" d={browPaths[shown] ?? neutralBrows} />
            <g className="eyes open" filter={url("eye-shadow")}>
              <ellipse cx="150" cy="160" rx="9" ry="13" fill={url("eye")} />
              <ellipse cx="210" cy="160" rx="9" ry="13" fill={url("eye")} />
              <ellipse
                cx="147"
                cy="155"
                rx="2.6"
                ry="3.6"
                style={{ fill: "var(--ora-eye-highlight)" }}
                opacity=".9"
              />
              <ellipse
                cx="207"
                cy="155"
                rx="2.6"
                ry="3.6"
                style={{ fill: "var(--ora-eye-highlight)" }}
                opacity=".9"
              />
              <circle
                cx="153"
                cy="166"
                r="1.3"
                style={{ fill: "var(--ora-eye-glint)" }}
                opacity=".4"
              />
              <circle
                cx="213"
                cy="166"
                r="1.3"
                style={{ fill: "var(--ora-eye-glint)" }}
                opacity=".4"
              />
            </g>
            <g className="closed">
              <path d="M 141 163 Q 150 148 159 163" />
              <path d="M 201 163 Q 210 148 219 163" />
            </g>
            <path
              className="smile"
              d={smilePaths[shown] ?? neutralSmile}
              filter={url("eye-shadow")}
            />
            <path
              className="mouth-open"
              d={shown === "surprised" ? roundMouth : openMouth}
              fill={url("eye")}
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
