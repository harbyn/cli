import { describe, expect, it } from "vitest";
import { banner, showsBanner } from "../src/banner.ts";

const ESC = String.fromCharCode(27);
const tty = (env: Record<string, string> = {}, platform = "linux") => ({
  isTTY: true,
  env,
  platform,
});

describe("banner", () => {
  it("shows only to a person at a terminal", () => {
    expect(showsBanner(tty(), false)).toBe(true);
    expect(showsBanner(tty(), true)).toBe(false);
    expect(showsBanner({ ...tty(), isTTY: false }, false)).toBe(false);
    expect(showsBanner(tty({ CI: "true" }), false)).toBe(false);
    expect(showsBanner(tty({ GITHUB_ACTIONS: "true" }), false)).toBe(false);
    expect(showsBanner(tty({ TERM: "dumb" }), false)).toBe(false);
  });

  it("draws the name in block letters, two blues, and none with NO_COLOR", () => {
    const colored = banner(tty({ COLORTERM: "truecolor" }));
    expect(colored).toContain(`${ESC}[38;2;169;198;227m`);
    expect(colored).toContain(`${ESC}[38;2;77;124;170m`);
    expect(banner(tty())).toContain(`${ESC}[38;5;67m`);
    const plain = banner(tty({ NO_COLOR: "1" }));
    expect(plain).not.toContain(ESC);
    expect(plain).toContain(String.fromCodePoint(0x2588));
    expect(plain).toContain("know before the APIs you depend on change");
  });

  it("falls back to plain ASCII where block characters may not render", () => {
    const old = banner(tty({ NO_COLOR: "1" }, "win32"));
    expect([...old].every((c) => (c.codePointAt(0) ?? 0) < 0x80)).toBe(true);
    expect(banner(tty({ NO_COLOR: "1", WT_SESSION: "1" }, "win32"))).toContain(
      String.fromCodePoint(0x2588),
    );
  });
});
