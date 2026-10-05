import { CLI_NAME, CLI_VERSION } from "./product.ts";

const GLYPHS: Readonly<Record<string, number>> = { "#": 0x2588, b: 0x2584, p: 0x2580 };
const ART = [
  "##  # b#ppb ##ppb ##ppb ##  # ##b #",
  "##pp# ##pp# ##ppb ##ppb pppp# ## p#",
  "pp  p pp  p pp  p pppp  pppp  pp  p",
];
const TONES = [
  "WW  W GWWWW WWWWW WWWGW WW  W WWG W",
  "WWGWW WWGWW WWGWW WWGWW GWGWW WW WW",
  "GW  W WW  W GW  W GWWW  GWWW  GW  W",
];
const ASCII = [
  " _     _ _______  ______ ______  __   __ __   _",
  " |_____| |_____| |_____/ |_____]   \\_/   | \\  |",
  " |     | |     | |    \\_ |_____]    |    |  \\_|",
];
export const TAGLINE = "know before the APIs you depend on change";

const ESC = String.fromCharCode(27);
const RGB = { W: [169, 198, 227], G: [77, 124, 170] } as const;
const ANSI256 = { W: 153, G: 67 } as const;

export interface Terminal {
  isTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
}

export const showsBanner = (t: Terminal, json: boolean): boolean =>
  t.isTTY && !json && !t.env.CI && !t.env.GITHUB_ACTIONS && t.env.TERM !== "dumb";

const blocksSupported = (t: Terminal): boolean =>
  t.platform !== "win32" ||
  Boolean(t.env.WT_SESSION || t.env.TERM_PROGRAM || t.env.TERM || t.env.ConEmuANSI === "ON");

export const banner = (t: Terminal): string => {
  const color = !t.env.NO_COLOR;
  const truecolor = /truecolor|24bit/i.test(t.env.COLORTERM ?? "") || Boolean(t.env.WT_SESSION);
  const paint = (tone: "W" | "G", text: string): string => {
    if (!color) return text;
    const code = truecolor ? `38;2;${RGB[tone].join(";")}` : `38;5;${ANSI256[tone]}`;
    return `${ESC}[${code}m${text}${ESC}[0m`;
  };
  const art = blocksSupported(t)
    ? ART.map((line, row) =>
        [...line]
          .map((ch, col) => {
            const glyph = GLYPHS[ch];
            return glyph === undefined
              ? ch
              : paint(TONES[row]?.[col] === "G" ? "G" : "W", String.fromCodePoint(glyph));
          })
          .join(""),
      )
    : ASCII.map((line) => paint("W", line));
  const title = color
    ? `${ESC}[1m${CLI_NAME} ${CLI_VERSION}${ESC}[0m`
    : `${CLI_NAME} ${CLI_VERSION}`;
  const tagline = color ? `${ESC}[2m${TAGLINE}${ESC}[0m` : TAGLINE;
  return ["", ...art, "", `${title}  ${tagline}`, ""].join("\n");
};
