/**
 * Parser for TrenchBroom / Quake-family .map text.
 *
 * Handles face lines in these formats:
 *   Standard:        ( p ) ( p ) ( p ) TEX offX offY rot scaleX scaleY
 *   Valve 220:       ( p ) ( p ) ( p ) TEX [ ux uy uz offU ] [ vx vy vz offV ] rot scaleX scaleY
 *   Quake2 / Q2 Valve: either of the above followed by: contentFlags surfaceFlags value
 * Brush primitives and patches (Quake 3 brushDef / patchDef2) are skipped.
 */
import type { Vec3 } from "../../math/vec3";

export interface StandardTexAxes {
  kind: "standard";
  offset: [number, number];
}

export interface ValveTexAxes {
  kind: "valve";
  u: Vec3;
  v: Vec3;
  offset: [number, number];
}

export interface MapFace {
  points: [Vec3, Vec3, Vec3];
  texture: string;
  axes: StandardTexAxes | ValveTexAxes;
  rotation: number;
  scale: [number, number];
  contentFlags: number;
  surfaceFlags: number;
  value: number;
}

export interface MapBrush {
  faces: MapFace[];
  line: number;
}

export interface MapEntity {
  properties: Record<string, string>;
  brushes: MapBrush[];
  line: number;
}

type TokenKind = "word" | "string" | "punct";
interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

export class MapParseError extends Error {
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === '"') {
      const start = ++i;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\n") line++;
        i++;
      }
      tokens.push({ kind: "string", text: src.slice(start, i), line });
      i++;
    } else if (c === "{" || c === "}" || c === "(" || c === ")" || c === "[" || c === "]") {
      tokens.push({ kind: "punct", text: c, line });
      i++;
    } else {
      const start = i;
      while (i < n && !/[\s{}()[\]"]/.test(src[i])) i++;
      tokens.push({ kind: "word", text: src.slice(start, i), line });
    }
  }
  return tokens;
}

const isNumber = (t: Token | undefined) => t !== undefined && t.kind === "word" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t.text);

export function parseMap(src: string): MapEntity[] {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = (): Token => {
    const t = tokens[pos++];
    if (!t) throw new MapParseError("unexpected end of file", tokens[tokens.length - 1]?.line ?? 1);
    return t;
  };
  const expect = (text: string): Token => {
    const t = next();
    if (t.text !== text || t.kind === "string") throw new MapParseError(`expected '${text}', got '${t.text}'`, t.line);
    return t;
  };
  const num = (): number => {
    const t = next();
    if (!isNumber(t)) throw new MapParseError(`expected number, got '${t.text}'`, t.line);
    return parseFloat(t.text);
  };
  const point = (): Vec3 => {
    expect("(");
    const p = { x: num(), y: num(), z: num() };
    expect(")");
    return p;
  };

  const skipBlock = () => {
    // Current token is the opening '{' of a block to skip.
    let depth = 0;
    do {
      const t = next();
      if (t.kind === "punct" && t.text === "{") depth++;
      else if (t.kind === "punct" && t.text === "}") depth--;
    } while (depth > 0);
  };

  const parseFace = (): MapFace => {
    const points: [Vec3, Vec3, Vec3] = [point(), point(), point()];
    const texTok = next();
    if (texTok.kind === "punct") throw new MapParseError(`expected texture name, got '${texTok.text}'`, texTok.line);
    let axes: MapFace["axes"];
    if (peek()?.text === "[") {
      expect("[");
      const u = { x: num(), y: num(), z: num() };
      const offU = num();
      expect("]");
      expect("[");
      const v = { x: num(), y: num(), z: num() };
      const offV = num();
      expect("]");
      axes = { kind: "valve", u, v, offset: [offU, offV] };
    } else {
      axes = { kind: "standard", offset: [num(), num()] };
    }
    const rotation = num();
    const scale: [number, number] = [num(), num()];
    // Optional Quake 2 style extras.
    const extras: number[] = [];
    while (extras.length < 3 && isNumber(peek())) extras.push(num());
    return {
      points,
      texture: texTok.text,
      axes,
      rotation,
      scale,
      contentFlags: extras[0] ?? 0,
      surfaceFlags: extras[1] ?? 0,
      value: extras[2] ?? 0,
    };
  };

  const parseBrushBody = (line: number): MapBrush | null => {
    // After the brush's opening '{'.
    const first = peek();
    if (first && first.kind === "word" && (first.text === "brushDef" || first.text === "patchDef2" || first.text === "patchDef3")) {
      next();
      skipBlock();
      expect("}");
      return null;
    }
    const faces: MapFace[] = [];
    while (peek()?.text !== "}") faces.push(parseFace());
    expect("}");
    return { faces, line };
  };

  const entities: MapEntity[] = [];
  while (pos < tokens.length) {
    const open = expect("{");
    const entity: MapEntity = { properties: {}, brushes: [], line: open.line };
    for (;;) {
      const t = next();
      if (t.kind === "punct" && t.text === "}") break;
      if (t.kind === "string") {
        const value = next();
        if (value.kind !== "string") throw new MapParseError(`expected value string for key '${t.text}'`, value.line);
        entity.properties[t.text] = value.text;
      } else if (t.kind === "punct" && t.text === "{") {
        const brush = parseBrushBody(t.line);
        if (brush) entity.brushes.push(brush);
      } else {
        throw new MapParseError(`unexpected '${t.text}' in entity`, t.line);
      }
    }
    entities.push(entity);
  }
  return entities;
}
