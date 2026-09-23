/**
 * Sinc's catalog identity rules, ported from Sincapp/tools/build_db.py.
 *
 * normalize() MUST produce the same keys as build_db.normalize() and
 * SampleDatabase.normalize (Sinc/Models.swift), or lookups here silently miss
 * rows the pipeline wrote. All three are pinned by the shared vectors in
 * Sincapp/tools/data/normalization_vectors.json (vendored in __fixtures__).
 */
import { createHash } from "node:crypto";

/** The catalog's `normalization_version` this port implements. */
export const NORMALIZATION_VERSION = "2";

/**
 * unicodedata.combining(c) != 0, which JavaScript has no API for.
 *
 * Canonical ordering sorts adjacent marks by combining class, so a scalar's
 * class shows in how normalization reorders it against marks of known class:
 * U+0334 has class 1 and U+0308 class 230. Only marks can have a non-zero
 * class, which keeps the NFD calls off ordinary letters. Callers pass scalars
 * that NFKD has already fully decomposed.
 */
function hasCombiningClass(scalar: string): boolean {
  if (!/\p{M}/u.test(scalar)) return false;
  // Class > 1 sorts before U+0334; class 1 sorts before U+0308.
  return (
    `${scalar}\u0334`.normalize("NFD").startsWith("\u0334") ||
    `\u0308${scalar}`.normalize("NFD").endsWith("\u0308")
  );
}

/** str.isspace() for one scalar, which is what str.split() splits on. */
function isPythonWhitespace(scalar: string): boolean {
  return /[\p{Zs}\t-\r\x1c-\x1f\x85\u2028\u2029]/u.test(scalar);
}

/** str.isalnum() for one scalar: a letter, or a number. */
function isPythonAlphanumeric(scalar: string): boolean {
  return /[\p{L}\p{N}]/u.test(scalar);
}

/** Runs of scalars that satisfy `keep`, joined by single spaces. */
function words(text: string, keep: (scalar: string) => boolean): string {
  const result: string[] = [];
  let current = "";
  for (const scalar of text) {
    if (keep(scalar)) {
      current += scalar;
    } else if (current) {
      result.push(current);
      current = "";
    }
  }
  if (current) result.push(current);
  return result.join(" ");
}

/** The lookup key for a title or artist. Mirrors build_db.normalize(). */
export function normalize(input: string): string {
  let s = "";
  for (const scalar of input.normalize("NFKD")) {
    if (!hasCombiningClass(scalar)) s += scalar;
  }
  // String.prototype.toLowerCase applies Unicode's Final_Sigma rule, as
  // Python's str.lower() does.
  s = s.toLowerCase();
  // s.find(opener, 1): an opener after the first character cuts there.
  for (const opener of ["(", "["]) {
    const i = s.indexOf(opener, 1);
    if (i > 0) s = s.slice(0, i);
  }
  const feat = s.indexOf("feat.");
  if (feat !== -1) s = s.slice(0, feat);
  s = s.replaceAll("&", "and");

  const symbolFallback = words(s, (scalar) => !isPythonWhitespace(scalar));
  return words(s, isPythonAlphanumeric) || symbolFallback;
}

/**
 * An ISRC or similar code in the form the catalog stores: upper case, letters
 * and digits only. Mirrors SampleDatabase.normalizeIdentifier (Models.swift).
 */
export function normalizeIdentifier(value: string): string {
  return [...value.toUpperCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

/**
 * normalize() without dropping bracketed qualifiers. Mirrors
 * build_db.version_key(): identity uses it to keep "Song (Remix)" apart from
 * "Song" when one derives from the other.
 */
export function versionKey(title: string): string {
  return normalize(title.replace(/[()[\]]/g, " "));
}

/** A stable, namespaced id: `<prefix>_<sha256 of the parts>`. */
export function canonicalId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex");
  return `${prefix}_${digest}`;
}

export type TrackKind = "song" | "film" | "tv" | "comedy" | "speech";

/**
 * Identity for a recording without a MusicBrainz id, as build_db.insert_node()
 * assigns it. A MusicBrainz recording id, when present, is identity instead:
 * `mb:recording:<mbid>`.
 */
export function textIdentity(
  kind: TrackKind,
  title: string,
  artist: string,
  version?: string,
): { identityKey: string; canonicalId: string } {
  const parts = [kind, normalize(title), normalize(artist)];
  if (version) parts.push(version);
  const identityKey = version
    ? `text:${parts.slice(0, 3).join(":")}:version:${version}`
    : `text:${parts.join(":")}`;
  return { identityKey, canonicalId: canonicalId("node", ...parts) };
}
