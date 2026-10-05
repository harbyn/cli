export const CLI_NAME = "harbyn";

declare const HARBYN_VERSION: string | undefined;
export const CLI_VERSION: string =
  typeof HARBYN_VERSION === "string" ? HARBYN_VERSION : "0.0.0-dev";

export const PAID_FIX_MESSAGE = `Automatic fixes and SDK migrations are part of Harbyn Pro and Team.
Switch them on for a repository from the dashboard, no terminal needed: https://harbyn.com/pricing
This open-source CLI finds what will break and where: run \`${CLI_NAME} scan\`.`;
