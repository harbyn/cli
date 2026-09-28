export const CLI_NAME = "harbyn";

declare const HARBYN_VERSION: string | undefined;
export const CLI_VERSION: string =
  typeof HARBYN_VERSION === "string" ? HARBYN_VERSION : "0.0.0-dev";
