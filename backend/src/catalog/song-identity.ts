/** Sinc/SongIdentity.swift, pinned by Sinc's song_identity_vectors.json. */
const versionWords = new Set([
  "mix", "remix", "rmx", "version", "edit", "instrumental", "dub", "extended",
  "remaster", "remastered", "radio", "album", "single", "original", "clean",
  "explicit", "mono", "stereo", "reconstruction", "vocal", "club", "rework",
  "digital", "bonus", "acapella", "cappella", "mixed", "live",
]);
const remixWords = new Set(["remix", "rmx", "dub", "rework", "reconstruction", "bootleg", "refix"]);
const qualifierWords = new Set([
  ...[...versionWords].filter((word) => !remixWords.has(word)),
  "a", "airplay", "alt", "alternate", "dj", "early", "extra", "full", "inch",
  "instrumentale", "long", "lp", "main", "og", "orig", "short", "special",
  "street", "take", "video", "nd", "rd", "st", "th", "s", "language",
  "english", "spanish", "french", "german", "italian", "portuguese",
  "japanese", "mandarin", "cantonese", "korean",
]);

const whitespace = /[\p{Zs}\t-\r\x1c-\x1f\x85\u2028\u2029]/u;
const alphanumeric = /[\p{L}\p{N}]/u;
const wordLetter = (scalar: string) => alphanumeric.test(scalar) && !/\p{Nd}/u.test(scalar);
const pythonStrip = (value: string) => {
  const scalars = [...value];
  while (scalars.length && whitespace.test(scalars[0]!)) scalars.shift();
  while (scalars.length && whitespace.test(scalars.at(-1)!)) scalars.pop();
  return scalars.join("");
};
const pythonRstrip = (value: string) => {
  const scalars = [...value];
  while (scalars.length && whitespace.test(scalars.at(-1)!)) scalars.pop();
  return scalars.join("");
};
const words = (value: string, keep: (scalar: string) => boolean): string[] => {
  const result: string[] = [];
  let current = "";
  for (const scalar of value.toLowerCase()) {
    if (keep(scalar)) current += scalar;
    else if (current) { result.push(current); current = ""; }
  }
  if (current) result.push(current);
  return result;
};

/** The title's loose identity plus credits in recognized remix suffixes. */
export function songIdentity(title: string): string {
  let current = pythonStrip(title);
  const remixes: string[] = [];
  for (;;) {
    const scalars = [...current];
    if (!scalars.length || ![")", "]"].includes(scalars.at(-1)!)) break;
    let opener = scalars.length - 2;
    while (opener >= 0 && !["(", "["].includes(scalars[opener]!)) {
      if ([")", "]"].includes(scalars[opener]!)) { opener = -1; break; }
      opener--;
    }
    if (opener < 0) break;
    const content = scalars.slice(opener + 1, -1).join("");
    const asciiWords = words(content, (s) => s >= "a" && s <= "z");
    if (!asciiWords.some((word) => versionWords.has(word))) break;
    const unicodeWords = words(content, wordLetter);
    if (unicodeWords.some((word) => remixWords.has(word) || !qualifierWords.has(word))) {
      remixes.push(unicodeWords.filter((word) => !qualifierWords.has(word)).join(""));
    }
    current = pythonRstrip(scalars.slice(0, opener).join(""));
  }
  const loose = [...current.toLowerCase()].filter((s) => alphanumeric.test(s)).join("");
  return [loose, ...remixes.reverse()].join("|");
}

export const isRemix = (title: string) => songIdentity(title).includes("|");
